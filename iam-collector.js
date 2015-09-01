var AWS = require('aws-sdk');
var Q = require('q');
var csv = require("fast-csv");
var merge = require("merge");

var AwsDataUtils = require('./aws-data-utils');

var promiseClient = function () {
    return Q(new AWS.IAM());
};

var generateCredentialReport = function (client) {
    return AwsDataUtils.collectFromAws(client, "generateCredentialReport");
};

var getCredentialReport = function (client) {
    return AwsDataUtils.collectFromAws(client, "getCredentialReport")
        .fail(function (v) {
            if (v.statusCode === 410) {
                // generate (not present, or expired)
                return Q(client).then(generateCredentialReport).delay(2000).thenResolve(client).then(getCredentialReport);
            } else if (v.statusCode === 404) {
                // not ready (generation in progress)
                return Q(client).delay(2000).then(getCredentialReport);
            } else {
                // other error
                return Q.reject(v);
            }
        });
};

var getCredentialReportCsv = function (client) {
    return getCredentialReport(client)
        .then(function (v) {
            if (v.ReportFormat !== 'text/csv') throw new Error('getCredentialReport did not return text/csv');
            var csv = new Buffer(v.Content, 'base64').toString();
            if (csv !== "" && csv[csv.length-1] !== "\n") csv = csv + "\n";
            return csv;
        });
};

var parseCsv = function (csvString) {
    var d = Q.defer();
    process.nextTick(function () {
        var rows = [];
        csv.fromString(csvString, {headers: true})
            .on("data", function (data) {
                rows.push(data);
            })
            .on("end", function () {
                d.resolve({ CredentialReport: rows });
            });
    });
    return d.promise;
};

var listGroups = function (client) {
    var paginationHelper = AwsDataUtils.paginationHelper("Marker", "Marker", "Groups");
    return AwsDataUtils.collectFromAws(client, "listGroups", {}, paginationHelper);
};

var getGroup = function (client, groupName) {
    return AwsDataUtils.collectFromAws(client, "getGroup", {GroupName: groupName});
};

var getGroups = function (client, listOfGroups) {
    var all = [];

    for (var i=0; i<listOfGroups.Groups.length; ++i) {
        all.push(
            Q([ client, listOfGroups.Groups[i].GroupName ])
                .spread(getGroup)
                .then(AwsDataUtils.tidyResponseMetadata)
        );
    }

    return Q.all(all)
        .then(function (groupResponses) {
            var g = {};
            for (var i=0; i<groupResponses.length; ++i) {
                g[ groupResponses[i].Group.GroupName ] = groupResponses[i];
            }
            return g;
        });
};

var listRoles = function (client) {
    var paginationHelper = AwsDataUtils.paginationHelper("Marker", "Marker", "Roles");

    return AwsDataUtils.collectFromAws(client, "listRoles", {}, paginationHelper)
        .then(function (v) {
            var roles = v.Roles;
            for (var i=0; i<roles.length; ++i) {
                roles[i].AssumeRolePolicyDocument = JSON.parse(decodeURIComponent(roles[i].AssumeRolePolicyDocument));
            }
            return v;
        });
};

var listUsers = function (client) {
    var paginationHelper = AwsDataUtils.paginationHelper("Marker", "Marker", "Users");
    return AwsDataUtils.collectFromAws(client, "listUsers", {}, paginationHelper);
};

var listAccountAliases = function (client) {
    return AwsDataUtils.collectFromAws(client, "listAccountAliases");
};

var joinResponses = function (key) {
    return function (responses) {
        var answer = {};
        answer[key] = [];

        // TODO what if any response contains any key other than 'key'?

        for (var i=0; i<responses.length; ++i) {
            answer[key] = answer[key].concat(responses[i][key]);
        }

        return answer;
    };
};

var listAccessKeys = function (client, listOfUsers) {
    var all = [];

    for (var i=0; i<listOfUsers.Users.length; ++i) {
        all.push(
            Q([ client, listOfUsers.Users[i].UserName ])
                .spread(listAccessKeysForUser)
                .then(AwsDataUtils.tidyResponseMetadata)
        );
    }

    return Q.all(all).then(joinResponses("AccessKeyMetadata"));
};

var listAccessKeysForUser = function (client, userName) {
    return AwsDataUtils.collectFromAws(client, "listAccessKeys", { UserName: userName });
};

var getInlinePoliciesForThing = function (client, thingName, thingNameKey, listMethod, getMethod) {
    var nameArgs = {};
    nameArgs[thingNameKey] = thingName;

    return AwsDataUtils.collectFromAws(
        client, listMethod, nameArgs, AwsDataUtils.paginationHelper("Marker", "Marker", "PolicyNames")
    ).then(function (d) {
        return Q.all(
            d.PolicyNames.map(function (policyName) {
                return Q(true).then(function () {
                    return AwsDataUtils.collectFromAws(client, getMethod, merge({}, nameArgs, {PolicyName: policyName}));
                });
            })
        );
    }).then(function (d) {
        var policies = d.reduce(function (x, y) {
            x[ y.PolicyName ] = JSON.parse(decodeURIComponent( y.PolicyDocument ));
            return x;
        }, {});

        return { Name: thingName, InlinePolicies: policies };
    });
};

var getInlinePoliciesForAllThings = function (client, listOfThings, thingsKey, thingNameKey, listMethod, getMethod) {
    return Q.all(
        listOfThings[thingsKey].map(function (thing) {
            return Q.all([ client, thing[thingNameKey], Q(thingNameKey), Q(listMethod), Q(getMethod) ])
                .spread(getInlinePoliciesForThing);
        })
    ).then(function (data) {
        return data.reduce(function (x, y) {
            x[ y.Name ] = y.InlinePolicies;
            return x;
        }, {});
    });
};

var getInlinePoliciesForAllUsers = function (client, listOfUsers) {
    return getInlinePoliciesForAllThings(client, listOfUsers, "Users", "UserName", "listUserPolicies", "getUserPolicy");
};

var getInlinePoliciesForAllGroups = function (client, listOfGroups) {
    return getInlinePoliciesForAllThings(client, listOfGroups, "Groups", "GroupName", "listGroupPolicies", "getGroupPolicy");
};

var getInlinePoliciesForAllRoles = function (client, listOfRoles) {
    return getInlinePoliciesForAllThings(client, listOfRoles, "Roles", "RoleName", "listRolePolicies", "getRolePolicy");
};

var collectAll = function () {
    var client = promiseClient();

    var gcr = client.then(getCredentialReportCsv).then(AwsDataUtils.saveContentTo("var/service/iam/credential-report.raw"));
    var jcr = gcr.then(parseCsv).then(AwsDataUtils.saveJsonTo("var/service/iam/credential-report.json"));

    var laa = client.then(listAccountAliases).then(AwsDataUtils.tidyResponseMetadata).then(AwsDataUtils.saveJsonTo("var/service/iam/list-account-aliases.json"));
    var lu = client.then(listUsers).then(AwsDataUtils.tidyResponseMetadata).then(AwsDataUtils.saveJsonTo("var/service/iam/list-users.json"));
    var lr = client.then(listRoles).then(AwsDataUtils.tidyResponseMetadata).then(AwsDataUtils.saveJsonTo("var/service/iam/list-roles.json"));
    var lak = Q.all([ client, lu ]).spread(listAccessKeys).then(AwsDataUtils.saveJsonTo("var/service/iam/list-access-keys.json"));

    var lg = client.then(listGroups);
    var gg = Q.all([ client, lg ]).spread(getGroups).then(AwsDataUtils.saveJsonTo("var/service/iam/get-groups.json"));

    var getInlinePolicies = Q.all([
        Q.all([ client, lu ]).spread(getInlinePoliciesForAllUsers).then(AwsDataUtils.saveJsonTo("var/service/iam/inline-user-policies.json")),
        Q.all([ client, lr ]).spread(getInlinePoliciesForAllRoles).then(AwsDataUtils.saveJsonTo("var/service/iam/inline-role-policies.json")),
        Q.all([ client, lg ]).spread(getInlinePoliciesForAllGroups).then(AwsDataUtils.saveJsonTo("var/service/iam/inline-group-policies.json")),
        Q(true)
    ]);

    // var lp = client.then(listPolicies).then(AwsDataUtils.tidyResponseMetadata).then(AwsDataUtils.saveJsonTo("var/service/iam/list-policies.json"));
    // listPolicies: a list of policies (includes AttachmentCount, but not
    // what it's attached to)
    // getPolicy: one of that list, but with an extra Description field
    // listPolicyVersions: list available versions for a policy (e.g. "v1")
    // getPolicyVersion: for the actual policy document

    // list-attached-group-policies (for a single group)
    // list-attached-role-policies (for a single role)
    // list-attached-user-policiess (for a single user)

    return Q.all([
        gcr, jcr,
        laa,
        gg,
        lu,
        lr,
        lak,
        getInlinePolicies,
        Q(true)
    ]);
};

module.exports = {
    collectAll: collectAll
};

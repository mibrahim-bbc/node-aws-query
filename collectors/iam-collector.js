/*
Copyright 2016 Rachel Evans

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

var AWS = require('aws-sdk');
var Q = require('q');
var csv = require("fast-csv");
var merge = require("merge");

var AtomicFile = require('../util/atomic-file');
var AwsDataUtils = require('../util/aws-data-utils');

var promiseClient = function (clientConfig) {
    return Q(new AWS.IAM(clientConfig));
};

var generateCredentialReport = function (client) {
    return AwsDataUtils.collectFromAws(client, "generateCredentialReport");
};

var getCredentialReport = function (client) {
    return AwsDataUtils.collectFromAws(client, "getCredentialReport")
        .fail(function (v) {
            if (v.statusCode === 410) { // v.code == "ReportNotPresent"
                // generate (not present, or expired)
                return Q(client).then(generateCredentialReport).delay(2000).thenResolve(client).then(getCredentialReport);
            } else if (v.statusCode === 404) { // v.code == "ReportInProgress"
                // not ready (generation in progress)
                return Q(client).delay(v.retryDelay * 1000).then(getCredentialReport);
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
            // var csv = new Buffer(v.Content, 'base64').toString();
            var csv = new Buffer.from(v.Content, 'base64').toString();
            if (csv !== "" && csv[csv.length-1] !== "\n") csv = csv + "\n";
            return csv;
        });
};

var parseCsv = function (csvString) {
    var d = Q.defer();
    process.nextTick(function () {
        var rows = [];
        csv.parseString(csvString, {headers: true})
            .on("data", function (data) {
                rows.push(data);
            })
            .on("end", function () {
                d.resolve({ CredentialReport: rows });
            });
    });
    return d.promise;
};

var listAccountAliases = function (client) {
    return AwsDataUtils.collectFromAws(client, "listAccountAliases");
};

var listAccessKeys = function (client, listOfUserNames) {
    return Q.all(
        listOfUserNames.map(function (u) {
            return Q([ client, u ]).spread(listAccessKeysForUser).then(AwsDataUtils.tidyResponseMetadata);
        })
    ).then(function (responses) {
        var allAKM = [];
        responses.forEach(function (e) { allAKM = allAKM.concat(e.AccessKeyMetadata); });
        return { AccessKeyMetadata: allAKM };
    });
};

var listAccessKeysForUser = function (client, userName) {
    return AwsDataUtils.collectFromAws(client, "listAccessKeys", { UserName: userName });
};

var getAccountAuthorizationDetails = function (client) {
    var paginationHelper = {
        nextArgs: function (args, data) {
            if (!data.Marker) return;
            return merge(true, args, {Marker: data.Marker});
        },
        promiseOfJoinedData: function (data1, data2) {
            return {
                UserDetailList: data1.UserDetailList.concat(data2.UserDetailList),
                GroupDetailList: data1.GroupDetailList.concat(data2.GroupDetailList),
                RoleDetailList: data1.RoleDetailList.concat(data2.RoleDetailList),
                Policies: data1.Policies.concat(data2.Policies)
            };
        }
    };
    return AwsDataUtils.collectFromAws(client, "getAccountAuthorizationDetails", {}, paginationHelper);
};

var decodePoliciesForAuthDetails = function (l) {
    l.GroupDetailList.forEach(function (g) {
        g.GroupPolicyList.forEach(function (p) {
            p.PolicyDocument = JSON.parse(decodeURIComponent(p.PolicyDocument));
        });
    });

    l.RoleDetailList.forEach(function (r) {
        r.AssumeRolePolicyDocument = JSON.parse(decodeURIComponent(r.AssumeRolePolicyDocument));

        r.RolePolicyList.forEach(function (p) {
            p.PolicyDocument = JSON.parse(decodeURIComponent(p.PolicyDocument));
        });

        r.InstanceProfileList.forEach(function (ip) {
            // role returned within itself
            ip.Roles.forEach(function (innerRole) {
                innerRole.AssumeRolePolicyDocument = JSON.parse(decodeURIComponent(innerRole.AssumeRolePolicyDocument));
            });
        });
    });

    l.UserDetailList.forEach(function (u) {
        u.UserPolicyList.forEach(function (p) {
            p.PolicyDocument = JSON.parse(decodeURIComponent(p.PolicyDocument));
        });
    });

    l.Policies.forEach(function (p) {
        p.PolicyVersionList.forEach(function (pv) {
            pv.Document = JSON.parse(decodeURIComponent(pv.Document));
        });
    });

    return l;
};

var listSSHPublicKeys = function (client, listOfUserNames) {
    var listSSHPublicKeysForUser = function (client, userName) {
        return AwsDataUtils.collectFromAws(client, "listSSHPublicKeys", { UserName: userName });
    };

    return Q.all(
        listOfUserNames.map(function (u) {
            return Q([ client, u ]).spread(listSSHPublicKeysForUser).then(AwsDataUtils.tidyResponseMetadata);
        })
    ).then(function (responses) {
        var sorter = function (a, b) {
            if (a.SSHPublicKeyId < b.SSHPublicKeyId) return -1;
            if (a.SSHPublicKeyId > b.SSHPublicKeyId) return +1;
            return 0;
        };
        var all = [];
        responses.forEach(function (e) { all = all.concat(e.SSHPublicKeys.sort(sorter)); });
        return { SSHPublicKeys: all };
    });
};

var listSigningCertificates = function (client, listOfUserNames) {
    var listForUser = function (client, userName) {
        return AwsDataUtils.collectFromAws(client, "listSigningCertificates", { UserName: userName });
    };

    return Q.all(
        listOfUserNames.map(function (u) {
            return Q([ client, u ]).spread(listForUser).then(AwsDataUtils.tidyResponseMetadata);
        })
    ).then(function (responses) {
        var sorter = function (a, b) {
            if (a.CertificateId < b.CertificateId) return -1;
            if (a.CertificateId > b.CertificateId) return +1;
            return 0;
        };
        var all = [];
        responses.forEach(function (e) { all = all.concat(e.Certificates.sort(sorter)); });
        return { Certificates: all };
    });
};

var listMFADevices = function (client, listOfUserNames) {
    var listForUser = function (client, userName) {
        return AwsDataUtils.collectFromAws(client, "listMFADevices", { UserName: userName });
    };

    return Q.all(
        listOfUserNames.map(function (u) {
            return Q([ client, u ]).spread(listForUser).then(AwsDataUtils.tidyResponseMetadata);
        })
    ).then(function (responses) {
        var sorter = function (a, b) {
            if (a.SerialNumber < b.SerialNumber) return -1;
            if (a.SerialNumber > b.SerialNumber) return +1;
            return 0;
        };
        var all = [];
        responses.forEach(function (e) { all = all.concat(e.MFADevices.sort(sorter)); });
        return { MFADevices: all };
    });
};

var listVirtualMFADevices = function (client) {
    var paginationHelper = AwsDataUtils.paginationHelper("NextMarker", "Marker", "VirtualMFADevices");
    return AwsDataUtils.collectFromAws(client, "listVirtualMFADevices", {}, paginationHelper)
        .then(AwsDataUtils.tidyResponseMetadata)
        .then(function (r) {
            r.VirtualMFADevices.sort(function (a, b) {
                if (a.SerialNumber < b.SerialNumber) return -1;
                else if (a.SerialNumber > b.SerialNumber) return +1;
                else return 0;
            });
            return r;
        });
};

var collectAll = function (clientConfig) {
    var client = promiseClient(clientConfig);

    var gaad = Q.all([ client ]).spread(getAccountAuthorizationDetails)
        .then(decodePoliciesForAuthDetails)
        .then(AtomicFile.saveJsonTo("service/iam/account-authorization-details.json"));

    var gcr = client.then(getCredentialReportCsv).then(AtomicFile.saveContentTo("service/iam/credential-report.raw"));
    var jcr = gcr.then(parseCsv).then(AtomicFile.saveJsonTo("service/iam/credential-report.json"));

    var laa = client.then(listAccountAliases).then(AwsDataUtils.tidyResponseMetadata).then(AtomicFile.saveJsonTo("service/iam/list-account-aliases.json"));

    var listOfUserNames = Q(gaad).then(function (l) {
        return l.UserDetailList.map(function (u) { return u.UserName; });
    });
    var lak = Q.all([ client, listOfUserNames ]).spread(listAccessKeys).then(AtomicFile.saveJsonTo("service/iam/list-access-keys.json"));

    var lSSHPublicKeys = Q.all([ client, listOfUserNames ]).spread(listSSHPublicKeys).then(AtomicFile.saveJsonTo("service/iam/list-ssh-public-keys.json"));
    var lSigningCertificates = Q.all([ client, listOfUserNames ]).spread(listSigningCertificates).then(AtomicFile.saveJsonTo("service/iam/list-signing-certificates.json"));
    var lMFADevices = Q.all([ client, listOfUserNames ]).spread(listMFADevices).then(AtomicFile.saveJsonTo("service/iam/list-mfa-devices.json"));
    var lVirtualMFADevices = client.then(listVirtualMFADevices).then(AtomicFile.saveJsonTo("service/iam/list-virtual-mfa-devices.json"));

    return Q.all([
        gaad,
        gcr, jcr,
        laa,
        lak,
        lSSHPublicKeys,
        lSigningCertificates,
        lMFADevices,
        lVirtualMFADevices,
        Q(true)
    ]);
};

module.exports = {
    collectAll: collectAll
};

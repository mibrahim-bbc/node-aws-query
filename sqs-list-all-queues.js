var Q = require('q');
var path = require('path');

var AwsDataUtils = require('./aws-data-utils');
var PrefixTruncationExpander = require('./prefix-truncation-expander');

var alphabet = '0123456789' +
    '-ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    '_abcdefghijklmnopqrstuvwxyz';

var maxResults = 1000;

var listAllQueues = function(sqs, prefix) {
    var expander = new PrefixTruncationExpander(
        function (p) {
            console.log("do listQueues prefix =", p);
            return AwsDataUtils.collectFromAws(sqs, "SQS", "listQueues", { QueueNamePrefix: p }, "QueueUrls")
                .then(function (r) {
                    return r.QueueUrls || [];
                });
        },
        function (s) {
            return path.basename(s);
        },
        alphabet,
        maxResults
    );

    return expander.expand(prefix)
        .then(function (urls) {
            return { QueueUrls: urls };
        });
};

module.exports = {
    listAllQueues: listAllQueues
};

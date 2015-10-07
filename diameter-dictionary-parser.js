'use strict';

var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var sax = require('sax');
var Q = require('q');
var loki = require('lokijs');


var dictionary = {};

var dictionaryDbLocation = path.normalize(__dirname + '/loki_dictionary.json');
var db = new loki(dictionaryDbLocation);

var collections = [
        'applications',
        'commands',
        'avps',
        'typedefns',
        'vendors'
    ];

var initDb = function() {
    _.each(collections, function(collection) {
        db.removeCollection(collection);
        dictionary[collection] = db.addCollection(collection);
    });
};

var parseDictionaryFiles = function(dictionaryFiles) {
    var deferred = Q.defer();
    
    var saxStream = sax.createStream(false, {lowercase: true});
    saxStream.setMaxListeners(100);

    var currentTags = {};

    var insertOrFind = function(collection, item, searchQuery) {
        var alreadyAdded = collection.findOne(searchQuery);
        if (_.isEmpty(alreadyAdded)) {
            collection.insert(item);
            return item;
        }
        return alreadyAdded;
    };

    var tagHandlers = {
        application: function(node) {
            currentTags.application = insertOrFind(dictionary.applications, node.attributes,
                { 'id': { '$eq': node.attributes.id.toString() } });
        },
        command: function(node) {
            var command = node.attributes;
            command.applicationId = currentTags.application.id;
            currentTags.command = insertOrFind(dictionary.commands, command,
                { '$and': [
                    { 'applicationId': { '$eq': command.applicationId.toString() } },
                    { 'code': { '$eq': command.code.toString() } }
                ] });
        },
        vendor: function(node) {
            currentTags.vendors = insertOrFind(dictionary.vendors, node.attributes,
                { 'id': { '$eq': node.attributes['vendor-id'].toString() } });
         },
        avp: function(node) {
            var avp = node.attributes;
            avp.applicationId = currentTags.application.id;
            currentTags.avp = insertOrFind(dictionary.avps, avp,
                { '$and': [
                    { 'applicationId': { '$eq': avp.applicationId.toString() } },
                    { 'code': { '$eq': avp.code.toString() } }
                ] });
        },
        base: function() {
            var baseApp = {
                id: '0',
                name: 'Diameter Common Messages'
            };
            currentTags.application = insertOrFind(dictionary.applications, baseApp,
                { 'id': { '$eq': baseApp.id.toString() } });
        },
        typedefn: function(node) {
            var typedefn = node.attributes;
            typedefn.applicationId = currentTags.application.id;
            currentTags.typedefn = insertOrFind(dictionary.typedefns, typedefn,
                { '$and': [
                    { 'applicationId': { '$eq': typedefn.applicationId.toString() } },
                    { 'type-name': { '$eq': typedefn['type-name'].toString() } }
                ] });
        },
        type: function(node) {
            var parent = currentTags.avp;
            parent.type = node.attributes['type-name'];
            dictionary.avps.update(parent);
        },
        'enum': function(node) {
            var parent = currentTags.avp;
            if (parent.enums == null) {
                parent.enums = [];
            }
            parent.enums.push(node.attributes);
            dictionary.avps.update(parent);
        },
        gavp: function(node) {
            var parent = currentTags.avp;
            parent.grouped = true;
            if (parent.gavps == null) {
                parent.gavps = [];
            }
            parent.gavps.push(node.attributes.name);
            dictionary.avps.update(parent);
        }
    };

    saxStream.on('error', function(error) {
        deferred.reject(error);
    });

    saxStream.on('opentag', function (node) {
        currentTags[node.name] = node.attributes;
        var tagHandler = tagHandlers[node.name];
        if (tagHandler) {
            tagHandler(node);
        }
    });
    
    saxStream.on('closetag', function (tag) {
        currentTags[tag] = null;
    });

    saxStream.on('end', function () {
        if (dictionaryFiles.length > 0) {
            fs.createReadStream(_.last(dictionaryFiles)).pipe(saxStream);
            dictionaryFiles = _.dropRight(dictionaryFiles);
        } else {
            db.save(function() {
                deferred.resolve(dictionary); 
            });
        }
    });

    fs.createReadStream(_.last(dictionaryFiles)).pipe(saxStream);
    dictionaryFiles = _.dropRight(dictionaryFiles);
    
    return deferred.promise;
};

var dictionaryDeferred = Q.defer();
var getDictionary = function() {
    var dictionariesLocation = path.normalize(__dirname + '/dictionaries');

    initDb();

    fs.readdir(dictionariesLocation, function(error, files) {
        if (!_.isEmpty(error)) {
            dictionaryDeferred.reject('Error reading dictionary files: ' + error);
            return;
        }
        files = _(files)
            .filter(function(file) {
                return _.endsWith(file.toLowerCase(), '.xml');
            })
            .map(function(file) {
                return path.normalize(dictionariesLocation + '/' + file);
            }).value();
        if (files.length > 0) {
            parseDictionaryFiles(files).then(dictionaryDeferred.resolve, 
                    dictionaryDeferred.reject);
        } else {
            dictionaryDeferred.reject('Dictionary files not found');
        }
    });
    return dictionaryDeferred.promise;
};


var getTypedefn = function(type, appId) {
    var typedefn = dictionary.typedefns.find({
        '$and': [{
            'applicationId': {
                '$eq': appId.toString()
            }
        }, {
            'type-name': {
                '$eq': type.toString()
            }
        }]
    });
    if (typedefn.length == 0 && appId !== '0') {
        return getTypedefn(type, '0');
    }
    return typedefn[0];
};

var resolveToBaseType = function(type, appId) {
    if (type == 'QoSFilterRule') return 'OctetString';
    if (type == 'Float32') return 'Unsigned32';
    if (type == 'Float64') return 'Unsigned64';
    if (type == 'Address') return 'OctetString';
    var parsableTypes = [
        'OctetString',
        'Unsigned32',
        'Integer32',
        'Unsigned64',
        'Integer64',
        'Time',
        'IPAddress'
        ];
    var typedefn = getTypedefn(type, appId);
    if (_.contains(parsableTypes, typedefn['type-name'])) {
        return typedefn['type-name'];
    } else if (typedefn['type-parent'] !== undefined) {
        return resolveToBaseType(typedefn['type-parent'], appId);
    }
    throw new Error('Unable to resolve type ' + type + ' for app ' + appId);
};

console.log('Parsing diameter dictionaries...');
getDictionary().then(function() {
    console.log('Dictionaries parsed to loki_dictionary.json');
    
    // This part stores it in plain JSON
    
    var applications = dictionary.applications.find().map(function(app) {
        return {
            code: parseInt(app.id, 10),
            name: app.name
        };
    });

    var commands = dictionary.commands.find().map(function(com) {
        var vendor = dictionary.vendors.findOne({
                'vendor-id': {
                    '$eq': com['vendor-id']
                }
            });
        var vendorId = vendor == null ? 0 : parseInt(vendor.code, 10);
        
        return {
            code: parseInt(com.code, 10),
            name: com.name,
            vendorId: vendorId
        };
    });
    
    var avps = dictionary.avps.find().map(function(a) {
        var vendor = dictionary.vendors.findOne({
                'vendor-id': {
                    '$eq': a['vendor-id']
                }
            });
        var vendorId = vendor == null ? 0 : parseInt(vendor.code, 10);
           
        var avp =  {
            code: parseInt(a.code, 10),
            name: a.name,
            vendorId: vendorId,
            type: a.type == null ? undefined : resolveToBaseType(a.type, a.applicationId),
            flags: {
                mandatory: a.mandatory == 'must',
                'protected': a['protected'] == 'may',
                mayEncrypt: a['may-encrypt'] == 'yes',
                vendorBit: a['vendor-bit'] == 'must'
            }
        };
        
        if (a.gavps != null) {
            avp.groupedAvps = a.gavps;
            avp.type = 'Grouped';
        }
        
        if (a.enums != null) {
            avp.enums = _.map(a.enums, function(e) {
                return {code: parseInt(e.code, 10), name: e.name};
            });
        }
        
        return avp;
    });
    
    var dict = {
        applications: _.sortBy(applications, 'code'),
        commands: _.sortBy(commands, 'code'),
        avps: _.sortBy(avps, 'code')
    };
    
    fs.writeFile('dictionary.json', JSON.stringify(dict, null, 4), function(err) {
    if(err) {
      console.log(err);
    } else {
      console.log("JSON saved to " + 'dictionary.json');
    }
}); 
}, function(err) {
    console.log('Error: ' + err);
}).done();
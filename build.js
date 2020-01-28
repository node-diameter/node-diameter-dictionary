'use strict';

var fs = require('fs');
var Readable = require('stream').Readable;
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

var parseDictionaryFile = function(dictionaryFile) {
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
            if (currentTags.application) {
                avp.applicationId = currentTags.application.id;
                currentTags.avp = insertOrFind(dictionary.avps, avp,
                    { '$and': [
                        { 'applicationId': { '$eq': avp.applicationId.toString() } },
                        { 'code': { '$eq': avp.code.toString() } }
                    ] });
            } else if (currentTags.vendors) {
                if (currentTags.vendors instanceof Array) {
                    throw new Error('Expected vendor as parent element');
                }
                avp.applicationId = 0;
                avp.vendorId = currentTags.vendors['vendor-id'];
                currentTags.avp = insertOrFind(dictionary.avps, avp,
                    { '$and': [
                        { 'vendorId': { '$eq': avp.vendorId.toString() } },
                        { 'code': { '$eq': avp.code.toString() } }
                    ] });
            } else {
                throw new Error('Neither the application nor the vendor is known');
            }
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
        grouped: function(node) {
            var parent = currentTags.avp;
            parent.grouped = true;
            dictionary.avps.update(parent);
        },
        gavp: function(node) {
            var parent = currentTags.avp;
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
        db.save(function() {
            deferred.resolve(dictionary);
        });
    });

    var xml = fs.readFileSync(dictionaryFile, 'utf-8');

    var entityMap = {};
    var entityRe = /<!ENTITY\s+(.+?)\s+SYSTEM\s+"(.+)"\s*>/g;
    var tokens;

    while (tokens = entityRe.exec(xml)) {
        var entityName = tokens[1];
        var entityUri = tokens[2];
        var entityPath = path.join(path.dirname(dictionaryFile), entityUri);

        entityMap[entityName] = fs
            .readFileSync(entityPath, 'utf-8')
            .replace(/<\?xml.+\?>/, '');
    }

    xml = xml.replace(/\&([^;]+);/g, function(s, entityName) {
        return entityMap[entityName] || s;
    });

    var xmlStream = new Readable();
    xmlStream.push(xml);
    xmlStream.push(null);
    xmlStream.pipe(saxStream);

    return deferred.promise;
};

var dictionaryDeferred = Q.defer();
var getDictionary = function() {
    var dictionaryLocation = path.join(__dirname, 'node_modules', 'wireshark.git#bf38a67724d09be2f4032d979d8fc7d25f5a46ef',  'diameter', 'dictionary.xml');

    initDb();

    parseDictionaryFile(dictionaryLocation).then(dictionaryDeferred.resolve,
            dictionaryDeferred.reject);

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
    if (type == 'QoSFilterRule') return 'UTF8String';
    if (type == 'Float32') return 'Unsigned32';
    if (type == 'Float64') return 'Unsigned64';
    if (type == 'Address') return 'OctetString';
    if (type == 'DiameterIdentity') return 'UTF8String';
    if (type == 'IPFilterRule') return 'UTF8String';
    var parsableTypes = [
        'OctetString',
        'UTF8String',
        'Unsigned32',
        'Integer32',
        'Unsigned64',
        'Integer64',
        'Time',
        'IPAddress',
        'AppId'
        ];
    var typedefn = getTypedefn(type, appId);
    if (_.includes(parsableTypes, typedefn['type-name'])) {
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

        if (a.grouped) {
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
        commands: _.sortBy(commands, [ 'code', 'vendorId' ]),
        avps: _.sortBy(avps, [ 'code', 'vendorId' ])
    };

    fs.writeFile('dist/dictionary.json', JSON.stringify(dict, null, 4), function(err) {
    if(err) {
      console.log(err);
    } else {
      console.log("JSON saved to " + 'dist/dictionary.json');
    }
});
}, function(err) {
    console.log('Error: ' + err);
}).done();

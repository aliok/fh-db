var fhdb = require('./fhmongodb.js');
var EventEmitter = require('events').EventEmitter;
var util = require("util");
var async = require('async');
var MAX_COLLECTION_NAME = 70;
// If not single db per app, we need to be passed a valid AppName string, otherwise could be manipulating into listing anything
var appname_regex = /.+-[a-zA-Z0-9]{24}-/;
var importExportHelpers;

var Ditcher = function (cfg, lgr, versionNumber, callback) {
  var self = this;

  self.versionNumber = versionNumber;

  self.config = cfg;
  self.logger = lgr;
  self.database = new fhdb.Database(self.config.database.host, self.config.database.port, self.config.database.driver_options, self.config.retryConfig, self.config.database.name);
  self.database.name = self.config.database.name;
  importExportHelpers = require('./importexport/helpers.js')(self.logger);

  self.database.on("tearUp", function () {
    self.logger.info("Database opened " + versionNumber);
    if ('function' == typeof callback) {
      return callback();
    }
  });

  self.database.on("tearDown", function () {
    self.logger.info("Database closed.. " + versionNumber);
  });

  self.database.on("error", function (err) {
    self.logger.error("Database error: " + err + " :: " + versionNumber);
  });

  self.database.on("dbconnectionerror", function (err) {
    self.logger.error("Database connection error: " + err + " :: " + versionNumber);
    self.emit("dbconnectionerror", err);
  });

  self.logger.info("Database about to tear up... " + versionNumber);

  self.database.tearUp(cfg.database.auth);
};

util.inherits(Ditcher, EventEmitter);

var crit_ops = {
  eq: function (query, fields) {
    var field;
    if (null !== fields) {
      for (field in  fields) {
        if (fields.hasOwnProperty(field)) {
          query[field] = fields[field];
        }
      }
    }
  },
  ne: function (query, fields) {
    buildQuery(query, fields, "$ne");
  },
  lt: function (query, fields) {
    buildQuery(query, fields, "$lt");
  },
  le: function (query, fields) {
    buildQuery(query, fields, "$lte");
  },
  gt: function (query, fields) {
    buildQuery(query, fields, "$gt");
  },
  ge: function (query, fields) {
    buildQuery(query, fields, "$gte");
  },
  like: function (query, fields) {
    buildQuery(query, fields, "$regex");
  },
  "in": function (query, fields) {
    buildQuery(query, fields, "$in");
  },
  geo: function (query, fields) {
    if (null !== fields) {
      var field;
      var earthRadius = 6378; //km
      for (field in  fields) {
        if (fields.hasOwnProperty(field)) {
          var queryField = {};
          if ('undefined' !== typeof query[field]) {
            queryField = query[field];
          }
          queryField["$within"] = {
            "$centerSphere": [  // supported by mongodb V1.8 & above
              fields[field].center,
              fields[field].radius / earthRadius
            ]
          };
          query[field] = queryField;
        }
      }
    }
  }
};

function buildQuery(query, fields, expression) {
  var field;
  if (null !== fields) {
    for (field in  fields) {
      if (fields.hasOwnProperty(field)) {
        var queryField = {};
        if ('undefined' !== typeof query[field]) {
          queryField = query[field];
        }
        queryField[expression] = fields[field];
        query[field] = queryField;
      }
    }
  }
}

function checkParams(params) {
  return params && params.__fhdb && params.type;
}


//This function should not append the ditch prefixes if accessing apps own database
//__fhdb is the full domain-guid-env app name, type is the collectionName
//
function constructCollectionName(params) {

  //If the parameter __dbperapp is passed, then the app is accessing its own database.
  if (params.__dbperapp) {
    return params.type;
  }
  else {
    return "fh_" + params.__fhdb + "_" + params.type;
  }

}

function getTypeNameFromCollectionName(params, record){
  // If we're not in single-db-per-app mode, let's still list collections - just filter out any that don't relate to this app
  if (params.__dbperapp){
    return record.name;
  }
  var sharedCollectionPrefix = constructCollectionName({
    __fhdb : params.__fhdb, // equates to the AppName
    type : ''
  });
  return record.name.replace(sharedCollectionPrefix, '');
}

function generateReturn(document, type) {
  var retDoc = {};
  if (null !== document && typeof( document) !== "undefined") {
    if (document._id) {
      retDoc.type = type;
      retDoc.guid = JSON.parse(JSON.stringify(document._id));
    }
    var i = 0;
    for (var field in document) {
      if (field !== "_id") {
        if (i === 0) {
          retDoc.fields = {};
          i = 1;
        }
        retDoc.fields[field] = document[field];
      }
    }
  }
  return retDoc;
}

Ditcher.prototype.tearDown = function () {
  var self = this;
  self.logger.info("TEARDOWN - " + self.versionNumber);

  self.database.tearDown();

};

Ditcher.prototype.doCreate = function (params, callback) {
  var self = this;
  var ret;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  //If there are no fields in the create request, then it can be interpreted as an attempt to create just a collection
  //CheckParams has already checked for the existence of the __fhdb and type parameter

  //If fields are included, they must be of type object to be accepted by the database.
  if(params.fields){
    if(!(typeof(params.fields) === "object")){
      return callback(new Error("Invalid Param Field Type. Expected type object. Param type is " + typeof(params.fields)));
    }
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }

  var coll = constructCollectionName(params);
  if (params.fields) {//If the collection does exist and there is a call to create it with no type parameter, will just reply with ok
    self.database.create(coll, params.fields, function (err, doc) {
      if (err) return callback(err, null);
      var count = doc.length;

      if (count === 1) {
        ret = generateReturn(doc[0], params.type);
      } else {
        ret = {
          "Status": "OK",
          "Count": count
        };
      }
      return callback(null, ret);
    });
  } else {
    ret = {
      "Status": "OK",
      "Count": 0
    };
    return callback(null, ret);
  }
};

Ditcher.prototype.doList = function (params, callback) {
  var self = this;

  //This should only be callable if the app is referencing its own database
  if (!params.type && params.__fhdb) {
    return self.doListCollections(params, callback);
  }


  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }

  var coll = constructCollectionName(params);

  var query = {};
  for (var op in crit_ops) {
    var fields_values = params[op];
    if (fields_values) {
      crit_ops[op](query, fields_values);
    }
  }
  self.logger.debug("Ditcher.list/query: " + JSON.stringify(query));

  var fields = {};
  if (params.fields) {
    for (var i = 0; i < params.fields.length; i += 1) {
      fields[params.fields[i]] = 1;
    }
  }

  var options = {};
  if (params.skip && typeof params.skip === 'number' && params.skip >= 0) {
    options.skip = params.skip;
  }
  if (params.limit && typeof params.limit === 'number' && params.limit > 0) {
    options.limit = params.limit;
  }

  if (params.sort && typeof params.sort === 'object') { // array is typeof object too, so valid
    options.sort = params.sort; //TOD: Should we validate more here? Hard to validate..
  }

  self.database.findWithSelection(coll, query, fields, options, function (err, docs) {

    if (null !== err) {
      self.logger.debug("Ditcher.list/result: err=" + err);
      return callback(err, docs);
    }

    self.logger.debug("Ditcher.list/result: docs.length=" + docs.length);
    var retDocs = [];
    for (var i = 0; i < docs.length; i += 1) {
      retDocs.push(generateReturn(docs[i], params.type));
    }
    callback(null, retDocs);
  });
};

Ditcher.prototype.doListCollections = function (params, callback) {
  var self = this;

  if (!params.__fhdb ||
    (!params.__dbperapp && !appname_regex.test(params.__fhdb)) ||
    (params.__dbperapp ===true && params.__fhdb !== self.database.name)) {
    return callback(new Error("Incorrect parameters for listing collections"));
  }

  self.database.collectionNames(function (err, names) {
    var getters = [],
      i, curName, c, length, memory;
    if (null !== err) {
      self.logger.debug("Ditcher.listCollections/result: err=" + err);
      return callback(err);
    }
    for (i = 0; i < names.length; i++) {
      curName = names[i];

      if (!curName.name || curName.name.indexOf('system.') > -1) {
        // Skip system collections and faulty collection listings
        continue;
      }

      if (!params.__dbperapp && curName.name.indexOf(params.__fhdb) === -1){
        continue;
      }

      curName.name = curName.name.replace(self.database.name + '.', '');

      (function (self, record) {
        getters.push(function (cb) {
          var curCollection;
          self.database.collectionInfo(record.name, function (err, stats) {
            if (err) {
              return cb(err);
            }
            curCollection = {
              // If shared collection, remove the appName (aka params.__fhdb) prefix
              name : getTypeNameFromCollectionName(params, record),
              size: stats.size,
              count: stats.count
            };
            return cb(null, curCollection);
          });
        });
      })(self, curName);
    }
    async.parallel(getters, callback);
  });
};

Ditcher.prototype.doRead = function (params, callback) {
  var self = this;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }

  var coll = constructCollectionName(params);

  var query = {};
  try {
    query = {"_id": self.database.createObjectIdFromHexString(params.guid)};
  } catch (err) {
    // if the guid passed is not a hex ObjectID, use it as is
    query = {"_id": params.guid};
  }
  self.logger.debug("Ditcher.read/query: " + JSON.stringify(query));

  var fields = {};
  if (params.fields) {
    for (var i = 0; i < params.fields.length; i += 1) {
      fields[params.fields[i]] = 1;
    }
  }

  self.database.findOne(coll, query, fields, function (err, doc) {
    if (null !== err) {
      callback(err, null);
    } else {
      var ret = generateReturn(doc, params.type);
      self.logger.debug("generateReturn: " + JSON.stringify(ret));
      callback(null, ret);
    }
  });
};

Ditcher.prototype.doUpdate = function (params, callback) {
  var self = this;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }
  var coll = constructCollectionName(params);

  if (typeof(params.fields) === "undefined") {
    return callback(new Error("Invalid Params - 'fields' object required"));
  }

  var criteria = {};
  try {
    criteria = {"_id": self.database.createObjectIdFromHexString(params.guid)};
  } catch (err) {
    // if the guid passed is not a hex ObjectID, use it as is
    criteria = {"_id": params.guid};
  }
  self.logger.debug("Ditcher.update/criteria: " + JSON.stringify(criteria));

  self.database.update(coll, criteria, params.fields, null, function (err, res) {
    self.doRead(params, callback);
  });
};

Ditcher.prototype.doIndex = function (params, callback) {
  var self = this;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }
  var coll = constructCollectionName(params);

  var indexes = params.index;
  if (typeof indexes === "undefined") {
    return callback(new Error("Invalid Params - 'index' object required"));
  }
  var mapObj = {
    "ASC": 1,
    "DESC": -1,
    "2D": "2d"
  };
  for (var indx in indexes) {
    var type = indexes[indx].toString().toUpperCase();
    var mongoType = mapObj[type] || 1;
    indexes[indx] = mongoType;
  }
  self.database.index(coll, indexes, function (err, name) {
    callback(err, !err ? {"status": "OK", "indexName": name} : {"status": "ERROR"});
  });

};

Ditcher.prototype.doDelete = function (params, callback) {
  var self = this;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }
  var coll = constructCollectionName(params);

  // Read the object before deleting so we can return it
  self.doRead(params, function (readErr, readRes) {
    if(readErr) return callback(readErr);
    var id = params.guid;
    self.logger.debug("Ditcher.delete/id: " + id);
    self.database.remove(coll, id, function (deleteErr, deleteRes) {
      // Send back a copy of the data that was deleted
      callback(deleteErr, readRes);
    });
  });
};

Ditcher.prototype.doDeleteAll = function (params, callback) {
  var self = this;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }
  var coll = constructCollectionName(params);

  if (params.guid) {
    return callback(new Error("Invalid Params - no guid required"));
  }
  self.logger.info("Ditcher.deleteAll/coll: " + coll);
  self.database.removeAll(coll, function (deleteErr, data) {
    var status;
    if (!deleteErr) {
      status = {status: "ok", count: data};
    }
    callback(deleteErr, status);
  });
};

Ditcher.prototype.doDropCollection = function (params, callback) {
  var self = this;
  if (!checkParams(params)) {
    return callback(new Error("Invalid Params"));
  }

  if (params.type && params.type.length > MAX_COLLECTION_NAME) {
    return callback("Error: 'type' name too long: '" + params.type + "'. Collection name cannot be greater than: " + MAX_COLLECTION_NAME);
  }
  var coll = constructCollectionName(params);

  if (params.guid) {
    return callback(new Error("Invalid Params - no guid required"));
  }
  self.logger.info("Ditcher.dropCollection/coll: " + coll);
  self.database.dropCollection(coll, function (deleteErr, result) {
    var status;
    if (!deleteErr) {
      status = {status: "ok", result: result};
    }
    callback(deleteErr, status);
  });
};

Ditcher.prototype.checkStatus = function (cb) {
  var self = this;
  self.database.checkStatus(cb);
};

Ditcher.prototype.doExport = function (params, cb) {
  var self = this;
  if (!params.__fhdb || (!params.__dbperapp && !appname_regex.test(params.__fhdb))) {
    return cb(new Error("Invalid Params"));
  }
  params.format = params.format || 'json';
  if (params.type){
    var fullName = constructCollectionName(params);
    return self.database.collection(fullName,function(err,collection){
      if (err){
        return cb("Could not find collection");
      }
      return collection.find().toArray(function(err, collection){
        if (err){
          return cb(err);
        }
        var collectionsToZip = {};
        collectionsToZip[params.type] = collection;
        return importExportHelpers.zipExport(collectionsToZip, params.format, cb);
      });
    });
  }else{
    this.doListCollections({ __dbperapp : params.__dbperapp, __fhdb : params.__fhdb }, function(err, res){
      if (err){
        return cb(err);
      }
      if (!res || typeof res.length === 'undefined' || res.length === 0){
        return cb("No collections to export");
      }
      var getters = {};
      res.forEach(function(coll){
        getters[coll.name] = function(calback){
          var sharedCollectionName = constructCollectionName({
            __fhdb : params.__fhdb, // equates to the AppName
            type : coll.name,
            __dbperapp : params.__dbperapp
          });
          self.database.collection(sharedCollectionName,function(err,collection){
            if (err){
              return calback("Could not find collection");
            }
            return collection.find().toArray(calback);
          });
        };
      });
      return async.parallel(getters, function(err, collections){
        if (err){
          return cb(err);
        }
        return importExportHelpers.zipExport(collections, params.format, cb);
      });
    });
  }
};

Ditcher.prototype.doImport = function (params, cb) {
  var self = this,
  importers = {},
  resSent = false;

  if (!params.__fhdb || !params.files || (!params.__dbperapp && !appname_regex.test(params.__fhdb))) {
    return cb(new Error("Invalid params"));
  }

  importExportHelpers.importFile(params, function(err, collectionsToImport){
    if (err){
      self.logger.error("Import error: " + err);
      return cb({ message : err });
    }
    if (!collectionsToImport){
      return cb('No collections found to import');
    }
    var collectionsToImportArray = Object.keys(collectionsToImport);

    collectionsToImportArray.forEach(function(colKey){
      var name = constructCollectionName({ __fhdb : params.__fhdb, __dbperapp : params.__dbperapp, type : colKey}),
      data = collectionsToImport[colKey];
      importers[colKey] = function(callback){
        self.database.create(name, data, callback);
      };
    });

    return async.parallel(importers, function(err, res){
      // Prevent DB error dupes being sent twice
      if (resSent){
        return;
      }
      resSent = true;
      if (err){
        if (err.toString().indexOf("duplicate key error")>-1){
          return cb({message : "You're importing duplicate data - please ensure your collections are empty before importing"});
        }
        return cb({message : err.toString()});
      }
      return cb(null, {ok : true, imported : collectionsToImportArray});

    });
  });
};



exports.Ditcher = Ditcher;

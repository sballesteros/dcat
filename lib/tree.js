var archy = require('archy')
  , flat = require('flat')
  , path = require('path');

module.exports = function(paths){

  return archy(reformat(unflatten(paths))[0]);

};


function unflatten(paths){

  var obj = {};

  paths.forEach(function(p){
    obj[p] = path.basename(p);      
  });
      
  return flat.unflatten(obj, {delimiter: path.sep});
};


/**
 * inspired from https://github.com/hughsk/file-tree
 */
function reformat(object) {
  if (typeof object !== 'object') return object;

  var entries = [];
  var entry;

  for (var key in object) {
    entry = reformat(object[key]);
    if (typeof entry === 'string') {
      entry.label = key;
      entries.push(entry);
    } else {
      entry = { nodes: entry, label: key };
      entries.push(entry);
    }
  }

  return entries;
};

ldpm
====

Package manager for linked data packages

[![NPM](https://nodei.co/npm/ldpm.png)](https://nodei.co/npm/ldpm/)


Usage:
======

##CLI

    $ ldpm --help
    Usage: ldpm <command> [options] where command is:
      - init [globs (*.csv, ...)] [urls] [-d, --defaults]
      - cat       <datapackage name>[@<version>]
      - get       <datapackage name>[@<version>] [-f, --force] [-c, --cache]
      - clone     <datapackage name>[@<version>] [-f, --force]
      - install   <datapackage name 1>[@<version>] <datapackage name 2>[@<version>] ... [-c, --cache] [-s, --save] [-f, --force]
      - publish
      - unpublish <datapackage name>[@<version>]
      - adduser
      - owner <subcommand> where subcommand is:
        - ls  <datapackage name>
        - add <user> <datapackage name>
        - rm  <user> <datapackage name>[@<version>]
      - search [search terms]


### Publishing and getting data packages

Given a [data package](http://dataprotocols.org/data-packages/):

    $ cat package.json
    
    {
      "name": "mydpkg",
      "description": "my datapackage",
      "version": "0.0.0",
      "keywords": ["test", "datapackage"],
    
      "resources": [
        {
          "name": "inline",
          "schema": { "fields": [ {"name": "a", "type": "string"}, {"name": "b", "type": "integer"}, {"name": "c", "type": "number"} ] },
          "data": [ {"a": "a", "b": 1, "c": 1.2}, {"a": "x", "b": 2, "c": 2.3}, {"a": "y", "b": 3, "c": 3.4} ]
        },
        {
          "name": "csv1",
          "format": "csv",
          "schema": { "fields": [ {"name": "a", "type": "integer"}, {"name": "b", "type": "integer"} ] },
          "path": "x1.csv"
        },
        {
          "name": "csv2",
          "format": "csv",
          "schema": { "fields": [ {"name": "c", "type": "integer"}, {"name": "d", "type": "integer"} ] },
          "path": "x2.csv"
        }
      ]
    }

stored on the disk as

    $ tree
    .
    ├── package.json
    ├── scripts
    │   └── test.r
    ├── x1.csv
    └── x2.csv

we can:

    $ ldpm publish
    ldpm http PUT https://registry.standardanalytics.io/mydpkg/0.0.0
    ldpm http 201 https://registry.standardanalytics.io/mydpkg/0.0.0
    + mydpkg@0.0.0

and reclone it:

    $ ldpm clone mydpkg
    ldpm http GET https://registry.standardanalytics.io/mydpkg?clone=true
    ldpm http 200 https://registry.standardanalytics.io/mydpkg?clone=true
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/debug
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/debug
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    .
    └─┬ mydpkg
      ├── package.json
      ├─┬ scripts
      │ └── test.r
      ├── x1.csv
      └── x2.csv

But to save space or maybe because you just need 1 resource, you can
also simply ask to get a package.json where all the resource data have
been replaced by and URL.

    $ ldpm get mydpkg
    ldpm http GET https://registry.standardanalytics.io/mydpkg
    ldpm http 200 https://registry.standardanalytics.io/mydpkg
    .
    └─┬ mydpkg
      └── package.json

For instance (using [jsontool](https://npmjs.org/package/jsontool))

    $ cat mydpkg/package.json | json resources | json -c 'this.name === "csv1"' | json 0.url

returns:

    https://registry.standardanalytics.io/mydpkg/0.0.0/csv1

Note that in case of resources using the ```require``` property (as
opposed to ```data```, ```path``` or ```url```), the metadata of the
resource (```schema```, ```format```, ...) have been retrieved.

Then you can consume the resources you want with the module
[data-streams](https://github.com/standard-analytics/data-streams).


On the opposite, you can also cache all the resources data (including
external URLs) in a _standard_ directory structure, available for all
the data packages stored on the registry.

    $ ldpm get mydpkg --cache
    ldpm http GET https://registry.standardanalytics.io/mydpkg
    ldpm http 200 https://registry.standardanalytics.io/mydpkg
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    .
    └─┬ mydpkg
      ├── package.json
      └─┬ data
        ├── inline.json
        ├── csv1.csv
        └── csv2.csv

Each resources of package.json now have a ```path``` property. For instance

    $ cat mydpkg/package.json | json resources | json -c 'this.name === "csv1"' | json 0.path

returns

    data/csv1.csv


### Installing data packages as dependencies of your project

Given a package.json with

    {
      "name": "test",
      "version": "0.0.0",
      "dataDependencies": {
        "mydpkg": "0.0.0"
      }
    }

one can run

    $ ldpm install
    ldpm http GET https://registry.standardanalytics.io/versions/mydpkg
    ldpm http 200 https://registry.standardanalytics.io/versions/mydpkg
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0
    .
    ├── data_modules
    └─┬ mydpkg
      └── package.json

Combined with the --cache option, you get:

    $ ldpm install --cache
    ldpm http GET https://registry.standardanalytics.io/versions/mydpkg
    ldpm http 200 https://registry.standardanalytics.io/versions/mydpkg
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    ldpm http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    ldpm http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    .
    ├── data_modules
    └─┬ mydpkg
      ├── package.json
      └─┬ data
        ├── inline.json
        ├── csv1.csv
        └── csv2.csv


```ldpm``` aims to bring all the goodness of the
[npm](https://npmjs.org/) workflow for your data needs. Run ```ldpm
--help``` to see the available options.


## Using ldpm programaticaly

You can also use ```ldpm``` programaticaly.

    var Ldpm = require('ldpm);
    var ldpm = new Ldpm(conf);
    
    ldpm.install(['mydpkg@0.0.0', 'mydata@1.0.0'], {cache: true}, function(err, dpkgs){
      //done!
    });
    ldpm.on('log', console.log); //if you like stuff on stdout


See ```bin/ldpm``` for examples


Registry
========

By default, ```ldpm``` uses our CouchDB powered
[data registry](https://github.com/standard-analytics/linked-data-registry)
hosted on [cloudant](https://sballesteros.cloudant.com).


License
=======

MIT

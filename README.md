dpm2
====

Like [npm](https://npmjs.org/) but for
[data packages](http://dataprotocols.org/data-packages/)!

[![NPM](https://nodei.co/npm/dpm2.png)](https://nodei.co/npm/dpm2/)


Usage:
======

##CLI

    $ dpm2 --help
    Usage: dpm2 <command> [options] where command is:
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

    $ dpm2 publish
    dpm2 http PUT https://registry.standardanalytics.io/mydpkg/0.0.0
    dpm2 http 201 https://registry.standardanalytics.io/mydpkg/0.0.0
    + mydpkg@0.0.0

and reclone it:

    $ dpm2 clone mydpkg
    dpm2 http GET https://registry.standardanalytics.io/mydpkg?clone=true
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg?clone=true
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/debug
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/debug
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
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

    $ dpm2 get mydpkg
    dpm2 http GET https://registry.standardanalytics.io/mydpkg
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg
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

    $ dpm2 get mydpkg --cache
    dpm2 http GET https://registry.standardanalytics.io/mydpkg
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
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

    $ dpm2 install
    dpm2 http GET https://registry.standardanalytics.io/versions/mydpkg
    dpm2 http 200 https://registry.standardanalytics.io/versions/mydpkg
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0
    .
    ├── data_modules
    └─┬ mydpkg
      └── package.json

Combined with the --cache option, you get:

    $ dpm2 install --cache
    dpm2 http GET https://registry.standardanalytics.io/versions/mydpkg
    dpm2 http 200 https://registry.standardanalytics.io/versions/mydpkg
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    dpm2 http GET https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/inline
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv1
    dpm2 http 200 https://registry.standardanalytics.io/mydpkg/0.0.0/csv2
    .
    ├── data_modules
    └─┬ mydpkg
      ├── package.json
      └─┬ data
        ├── inline.json
        ├── csv1.csv
        └── csv2.csv


```dpm2``` aims to bring all the goodness of the
[npm](https://npmjs.org/) workflow for your data needs. Run ```dpm2
--help``` to see the available options.


## Using dpm2 programaticaly


You can also use ```dpm2``` programaticaly.

    var Dpm = require('dpm2);
    var dpm = new Dpm(conf);

See ```bin/dpm2``` for examples.


## Using dpm2 with npm


```dpm2``` use the ```dataDependencies``` property of
```package.json``` and store the dependencies in a ```data_modules/```
directory so it can be used safely, without conflict as a
[post-install script](https://npmjs.org/doc/misc/npm-scripts.html) of
[npm](https://npmjs.org/).


Registry
========

By default, ```dpm2``` uses our CouchDB powered
[data registry](https://github.com/standard-analytics/data-registry)
hosted on [cloudant](https://sballesteros.cloudant.com).

Why dpm2 and not simple dpm ?
=============================

There is already a ```dpm``` being developed [here](https://github.com/okfn/dpm/) but it leverages
```npm``` and the [npm registry](https://github.com/isaacs/npmjs.org).

License
=======

MIT

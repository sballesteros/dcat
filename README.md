[![Stories in Ready](https://badge.waffle.io/standard-analytics/ldpm.png?label=ready)](https://waffle.io/standard-analytics/ldpm)
ldpm
====

Linked Data Package Manager.

[![NPM](https://nodei.co/npm/ldpm.png)](https://nodei.co/npm/ldpm/)

Usage:
======

##CLI

    Usage: ldpm <command> [options] where command is:
      - cat       <datapackage name>[@<version>] [-e, --expand]
      - install   <datapackage name 1>[@<version>] <datapackage name 2>[@<version>] ... [-t, --top] [-a, --all] [-c, --cache] [-s, --save]
      - publish
      - unpublish <datapackage name>[@<version>]
      - adduser
      - owner <subcommand> where subcommand is:
        - ls  <datapackage name>
        - add <user> <datapackage name>
        - rm  <user> <datapackage name>[@<version>]
      - search [search terms]
      - help [command]
    
    Options:
      -f, --force     just do it
      -t, --top       install in the current working directory (and not within datapackages/) 
      -a, --all       install all the files present in the directory at publication time
      -e, --expand    expand the JSON-LD document
      -s, --save      data packages will appear in your dataDependencies
      -c, --cache     store the dataset content on the disk
      -h, --help      print usage
      -v, --version   print version number


## Using ldpm programaticaly

You can also use ```ldpm``` programaticaly.

    var Ldpm = require('ldpm);
    var ldpm = new Ldpm(conf);
    
    ldpm.install(['mydpkg/0.0.0', 'mydata/1.0.0', 'http://example.com/mydata'], {cache: true}, function(err, dpkgs){
      //done!
    });
    ldpm.on('log', console.log); //if you like stuff on stdout


See ```bin/ldpm``` for examples.


Registry
========

By default, ```ldpm``` uses [Standard Analytics IO](http://standardanalytics.io)
[data registry](https://github.com/standard-analytics/linked-data-registry)
hosted on [cloudant](https://sballesteros.cloudant.com).

Roadmap
=======

package.json -> [datapackage](http://dataprotocols.org/data-packages/).json -> datapackage.[jsonld](http://json-ld.org) -> any webpage with [schema.org](http://schema.org) markup -> linked data FTW !


License
=======

MIT

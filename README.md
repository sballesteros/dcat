ldc
====

![ldc](https://raw2.github.com/standard-analytics/ldc/master/logo.png)

Linked Data Container manager.

[![NPM](https://nodei.co/npm/ldc.png)](https://nodei.co/npm/ldc/)

Usage:
======

##CLI

    Usage: ldc <command> [options] where command is:
      - init [globs] [urls] [-d, --defaults] Interactively create a container.jsonld file and add the files listed as globs (*.csv ... and urls) as dataset
      - cat       <container name>[@<version>] [-e, --expand]
      - install   <container name 1>[@<version>] <container name 2>[@<version>] <container url> ... [-t, --top] [-a, --all] [-c, --cache] [-s, --save]
      - publish
      - unpublish <container name>[@<version>]
      - adduser
      - owner <subcommand> where subcommand is:
        - ls  <container name>
        - add <user> <container name>
        - rm  <user> <container name>[@<version>]
      - search [search terms]
      - help [command]
    
    Options:
      -f, --force     overwrite previous if exists
      -d, --defaults  bypass the promzard prompt
      -t, --top       install in the current working directory (and not within ld_containers/)
      -a, --all       install all the files present in the directory at publication time
      -e, --expand    expand the JSON-LD document
      -s, --save      data packages will appear in your dataDependencies
      -c, --cache     store the dataset content on the disk
      -h, --help      print usage
      -v, --version   print version number


## Using ldc programaticaly

You can also use ```ldc``` programaticaly.

    var Ldc = require('ldc);
    var ldc = new Ldc(conf);
    
    ldc.install(['myctnr/0.0.0', 'mydata/1.0.0', 'http://example.com/mydata'], {cache: true}, function(err, ctnrs){
    //done!
    });
    ldc.on('log', console.log); //if you like stuff on stdout


See ```bin/ldc``` for examples.


Registry
========

By default, ```ldc``` uses [Standard Analytics IO](http://standardanalytics.io)
[data registry](https://github.com/standard-analytics/linked-data-registry)
hosted on [cloudant](https://sballesteros.cloudant.com).

License
=======

MIT

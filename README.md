ldpm
====

Linked Data package manager.

[![NPM](https://nodei.co/npm/ldpm.png)](https://nodei.co/npm/ldpm/)

Usage:
======

##CLI

    Usage: ldpm <command> [options] where command is:
      - init [globs] [urls] [-d, --defaults] [-b --codebundle <relative/path/to/code/directory>] Interactively create a package.jsonld file and add the files listed as globs (*.csv ... and urls) as dataset. Be sure to double quote the glob so that the shell does not expand them
      - cat       <package name>[@<version>] [-e, --expand]
      - install   <package name 1>[@<version>] <package name 2>[@<version>] <package url> ... [-t, --top] [-c, --cache] [-r, --require] [-s, --save]
      - publish
      - unpublish <package name>[@<version>]
      - adduser
      - owner <subcommand> where subcommand is:
        - ls  <package name>
        - add <user> <package name>
        - rm  <user> <package name>[@<version>]
      - search [search terms]
      - help [command]
    
    Options:
      -f, --force       overwrite previous if exists
      -d, --defaults    bypass the promzard prompt
      -t, --top         install in the current working directory (and not within ld_packages/)
      -e, --expand      expand the JSON-LD document
      -s, --save        data packages will appear in your dataDependencies
      -c, --cache       force the inlined dataset (contentData) to be stored in their own file in ld_resources/
      -b, --codebundle  treat the listed directory as a code project
      -h, --help        print usage
      -v, --version     print version number


## Using ldpm programaticaly

You can also use ```ldpm``` programaticaly.

    var Ldpm = require('ldpm);
    var ldpm = new Ldpm(conf);
    
    ldpm.install(['mypkg/0.0.0', 'mydata/1.0.0', 'http://example.com/mydata'], {cache: true}, function(err, pkgs){
    //done!
    });
    ldpm.on('log', console.log); //if you like stuff on stdout


See ```bin/ldpm``` for examples.


Registry
========

By default, ```ldpm``` uses [Standard Analytics IO](http://standardanalytics.io)
[linked data registry](https://github.com/standard-analytics/linked-data-registry)
hosted on [cloudant](https://sballesteros.cloudant.com).

License
=======

MIT

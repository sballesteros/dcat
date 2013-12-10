dpm-stan
========

A client (```dpm```) for the [data registry](https://github.com/standard-analytics/data-registry).

[![NPM](https://nodei.co/npm/dpm-stan.png)](https://nodei.co/npm/dpm-stan/)

Usage:
======

    $ dpm --help
    
    dpm <command> [options] where command is:
      - install   <datapackage name>[@<version>] [-f, --force] [-c, --cache]
      - publish
      - unpublish <datapackage name>[@<version>]
      - adduser
      - owner <subcommand> where subcommand is:
        - ls  <datapackage name>
        - add <user> <datapackage name>
        - rm  <user> <datapackage name>[@<version>]
      - search [search terms]
    
    Options:
      -f, --force    just do it
      -c, --cache    store the resources content on the disk in a data/ directory
      -h, --help     print usage
      -v, --version  print version number


You can also use ```dpm``` programaticaly.

    var Dpm = require('dpm-stan');
    var dpm = new Dpm(conf);


See ```bin/dpm``` for examples.

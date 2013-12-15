dpm-stan
========

A client (```dpm```) for the [data registry](https://github.com/standard-analytics/data-registry).

[![NPM](https://nodei.co/npm/dpm-stan.png)](https://nodei.co/npm/dpm-stan/)


Usage:
======


    $ dpm --help
    
    Usage: dpm <command> [options] where command is:
      - cat       <datapackage name>[@<version>]
        Display package.json on stdout. If @<version> is not specified, the latest version is returned.
      - get      <datapackage name>[@<version>] [-f, --force] [-c, --cache]
        Download a data package into a directory (named after the data package name).
      - clone    <datapackage name>[@<version>] [-f, --force]
        Download a data package into a directory (named after the data package name) reproducing the directory structure present at publication time (including any files or folder not listed as resources (e.g scripts/ ...)).
      - install   <datapackage name 1>[@<version>] <datapackage name 2>[@<version>] ... [-c, --cache] [-s, --save]
        Installs a list of data packages, and any data packages that they depends on as dependencies of your current project (i.e in a directory named "data_modules")
      - publish
        Publish the data package of the current working directory into the registry
      - unpublish <datapackage name>[@<version>]
        Unpublish a datapackage from the registry. If no version is specified, all the versions will be removed
      - adduser
        Register an user
      - owner <subcommand> where subcommand is:
        - ls  <datapackage name>
          List all the maintainers of the data package
        - add <user> <datapackage name>
          Add an user to the data package maintainers
        - rm  <user> <datapackage name>[@<version>]
          Remove an user from the data package maintainers
      - search [search terms]
        Search data packages by keywords
    
    Options:
      -f, --force    just do it
      -s, --save     data packages will appear in your dataDependencies
      -c, --cache    store the resources content on the disk in a data/ directory
      -h, --help     print usage
      -v, --version  print version number


You can also use ```dpm``` programaticaly.

    var Dpm = require('dpm-stan');
    var dpm = new Dpm(conf);


See ```bin/dpm``` for examples.

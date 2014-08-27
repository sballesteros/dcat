ldpm
====

```ldpm```: Linked Data package manager, ```robots.txt``` transformer.

Gives [schema.org](http://schema.org) access to your files and links.

[![NPM](https://nodei.co/npm/ldpm.png)](https://nodei.co/npm/ldpm/)

History
=======

[```package.json```](http://wiki.commonjs.org/wiki/Packages/1.1) -> [```datapackage.json```](http://dataprotocols.org/data-packages/) -> ```package.jsonld``` -> [```JSON-LD```](http://json-ld.org/) + [schema.org](http://schema.org) + [hydra](http://www.hydra-cg.com/) + [linked data fragment](http://www.hydra-cg.com/).


Registry
========

By default, ```ldpm``` uses [Standard Analytics IO](http://standardanalytics.io)
[linked data registry](https://github.com/standard-analytics/linked-data-registry)
hosted on [cloudant](https://standardanalytics.cloudant.com).

Tests
=====

You need a local instance of the [linked data registry](https://github.com/standard-analytics/linked-data-registry) running on your machine on port 3000. Then, run:

    npm test


License
=======

Apache-2.0.

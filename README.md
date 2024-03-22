# node-diameter-dictionary

Collated Wireshark dictionaries for Diameter

## Build

Run:

````bash
$ npm run build
````

to clone the latest or run

````bash
$ npm run build --commitid=0baad53fba83f1a704c50fccbb6adf63d05d39e4
````

to clone known commitid (replace sample one above with your desired one) of the [Wireshark repo](https://github.com/wireshark/wireshark).

The collated JSON dictionary will be saved as dist/dictionary.json

Tag a new version which is reflective of the version of the Wireshark dictionaries that were used and publish!

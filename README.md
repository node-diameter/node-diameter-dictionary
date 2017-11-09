# node-diameter-dictionary

Collated Wireshark dictionaries for Diameter

## Build

Clone a known tag (or latest) of the [Wireshark repo](https://github.com/wireshark/wireshark) and copy the contents of its diameter directory into the local dictionaries folder.

Then run:

````bash
$ npm run build
````

The collated JSON dictionary will be saved as dist/dictionary.json

Tag a new version which is reflective of the version of the Wireshark dictionaries that were used and publish!

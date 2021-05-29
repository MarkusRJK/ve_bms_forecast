### Description

The BMV sends out two types of packages, packages with:

- history data and
- actual measurements

Each line in a package starts with 0x0d 0x0a ('\r\n'). This is
important. A line consists of a key and a value, separated by 0x09
('\t'). Key and value are readable ASCII, i.e. a value of
100 milli-ampere is '100' as 3 characters/bytes.

A history package contains keys 'H[0-9]+'. Measurement keys consist of
one or more characters, e.g. 'V' for volts, 'SOC' for state of charge
or 'Alarm'.

A history package as well as actual measurement packages are ended
with the key 'Checksum' followed by tab 0x09 ('\t') and by a one
byte/character which contains the checksum of the package. Checksum
algorithm see code. The checksum byte may or may not be a readable
character.

The checksum value can be succeeded by:

- some garbage and 0x0d 0x0a ('\r\n') - the start character of the
  next package
- some garbage then a colon ':' followed by a reply to a command with
  its checksum byte at the end, followed by some more garbage and the
  next 0x0d 0x0a ('\r\n'), the start character of the next package

e.g. it may look like:

Checksum\t*:8E4EE00007B<garbage>\r\n

If several commands were sent to the BMV, there may be multiple
replies after the checksum, each starting with colon ':'.

A command response always starts with colon ':' and ends with 0x0a ('\n').


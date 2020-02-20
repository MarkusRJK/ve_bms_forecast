# ve_bms_forecast

### Install

```
$ npm install 
```

### Example
Get an example running in minutes:

1. make an empty directory
2. call
```
$ npm init
```
3. call
```
npm install git+https://git@github.com/MarkusRJK/ve_bms_forecast.git
```
4. copy an example from subdirectory
```
node_modules/ve_bms_forecast/examples
```
to your directory
5. configure the serial port to which your BMV is connected
6. run the code, e.g.
```
$ nodejs bmv-terminal.js
```

### Usage

```
var vedirect = require( 'vedirect' );
var bmvdata = {};
vedirect.open('/dev/ttyBMV0');
forever {
  bmvdata = vedirect.update();
  console.log(bmvdata.V);
}
vedirect.close('/dev/ttyBMV0');
```

### Restrictions

This version only can currently handle 1 Ve.Direct interface, as i haven't found a way to create udev rules for the 
new Ve.Direct devices (something about a missing \%{Serial id}

This version has been build/tested with Node v6
$curl --silent --location https://rpm.nodesource.com/setup_6.x | bash -

### References

This package uses a modified version of

https://github.com/Moki38/vedirect

The modifications made are

- register function to register frequently posted values from any of the 
  supported devices (BMV, MPPT,...)
- using units, descriptions, ... for each value - TODO: using Math.units

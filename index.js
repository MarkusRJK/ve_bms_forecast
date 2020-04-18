//
// BMV
//

//'use strict';

// TODO:
// - fix: logs are empty after introducing class Vitodron...
// - cope with unplugged cable:
//    events.js:183
//      throw er; // Unhandled 'error' event
//      ^
//
//    Error: Error: No such file or directory, cannot open /dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE1SUT80-if00-port0
// - logging uses american date format (mm/dd/yy) and am/pm - arrrghh
// - use soc closest to zero current of last x min
// - introduce force cmds that repeat + reset until done (done)
// - introduce optional read from cache
// - first parse: parse until checksum ok then create objects from it for cache - only then do the up/download of config
// - further parse: replace callback function by final parse function to do updates
// - register function has switch statement to create each object after each other (only those appearing in update packet)
// - add a on function for CHECKSUM that sends collection of all changes
// - remove map key from objects and do it like addressCache
// - iterate over bmvdata rather than map as bmvdata shall have all entries
// - response from BMV to set command: also compare returned value
// - make address class that handles adresses for display and use (endian swapping)
// - make on a list so many callbacks can be called: callbacks = []; callback.push(..); callback.find(x)
// - add timestamp when new package arrives
// - ensure setTimeout within class works
// - classes for CmdChecksum, Address, MessageQ

// FIXES needed:
// - unwarrented command 84F03 received - ignored
// - Reject: conv.hexToInt is not a function
// - Reject: this.registerListener is not a function
// - Reject: Cannot read property 'substring' of undefined
// - Q builds up and does not get processed
// - do not allow prioritized messages to be pushed in cmdMessageQ
// - read relay mode at startup and check cache in later stages whether it needs to be set
// - case setSOC was sent then setrelaymode queued with prio 1 then setrelay with prio 1
//   which got pushed before setrelaymode. Then processCommand deleted soc from
//   responsemap while responseHandler shifted the setRelay command of the cmdMessageQ
//   which was for some reason the first (consolidate cmdMessageQ and responseMap!)
// - response ... does not map any queued command:
// - restart (boot) delivers no checksum?!
//   [2020-04-17T13:26:06.061] [DEBUG] default - 'key' event:b; matches: b
//   [2020-04-17T13:26:06.719] [ERROR] default - data set checksum: NaN (NaN) - expected: c4!
//   [2020-04-17T13:26:07.229] [WARN] default - data set checksum: e5 (229) - expected: 4f (!


const Math = require('mathjs');
var fs = require('fs');
//var util = require('util');
//var log_file = fs.createWriteStream(__dirname + '/debug.log', {flags: 'w'});
var record_file = fs.createWriteStream(__dirname + '/serial-test-data.log', {flags: 'w'});
var log_stdout = process.stdout;
var serialport = require('serialport');
var conv = require('./hexconv');
var log4js = require('log4js');
var deviceCache = require('./device_cache.js');

log4js.configure({
  appenders: {
      everything: {
          type: 'file',
          filename: '/var/log/debug.log',
          // layout basic should result in 2020-02-20 ... format
          layout: { type: 'basic'}
      }
  },
  categories: {
    default: { appenders: [ 'everything' ], level: 'debug' }
  }
});



// e.g. set relay on, off, on, off, on, off mostly does not make
// sense so it is enough to send the last command "off"
var cmdCompression = true;
var isSerialOperational = false;

const logger = log4js.getLogger();
logger.level = 'debug';

var date = new Date();
logger.debug("Service started at " + date.toLocaleString('en-GB', { timeZone: 'UTC' }));

// Data model:
//
// Each value (volt, current, power, state of charge...) owns a register
// on the device. All registers are cached in objects of this application.
// These objects also provide conversions, formatters, units, callbacks
// on change, descriptions etc.
// The BMV sends some of these register values in one package every
// 1 second (1-second-updates). Among them are the history values
// (H1, H2, ...) and the actual values like voltage, current,
// power, state of charge.
//
// For convenience there are 3 maps pointing to the same objects:
//
// addressCache: maps addresses of device registers (keys) to objects,
//               e.g. the voltage 'V' is stored in register
//                    at address 0xED8D. When reading the value
//                    directly from the register it needs to be
//                    multiplied by 10 to get millivolts.
// bmvdata:      maps human readable names to the same objects,
//               e.g. 'V' is the upper voltage, hence bmvdata.upperVoltage
// map:          maps the keys of the 1-second-updates to the same objects
//               e.g. in the package is a string "V<tab>24340" which
//                    will be written to map['V'].value and
//               maps contains more values than contained in the packages

// Protocol on BMV 702:
//
// There are 2 periodic frames arriving at the serial port:
// 1. Frame with PID, V, VM, DM, I, P, CE, SOC, TTG, Alarm, Relay, AR,
//    BMV and FW + Checksum
// 2. Frame with H1-H18 + Checksum

// bmvdata maps human readable keys to objects
var bmvdata = deviceCache.bmvdata;
// map's keys correspond to the keys used in the frequent 1-second-updates
var map = deviceCache.map;
// addressCache's keys map the register's addresses to the objects
var addressCache = deviceCache.addressCache;

// // overloade console.log
// console.log = function(msg) 
// {
//     let d = new Date();
//     //log_file.write('[' + d.toUTCString() + '] ' + util.format(msg) + '\n');
//     log_file.write('[' + d.getTime() + '] ' + util.format(msg) + '\n');
//     //log_stdout.write(util.format(msg) + '\n');
// }

// List of getters and setters for the BMV (do your own setters and getters for
// MPPT, other BMV, Phoenix Inverter):
//
// NOTE: you can add your own getter and setters, however keep in mind:
//
//       1 reading from the 1-second-updates device cache is much faster for
//         values contained in the update package. Getting a value
//         from a register takes in avg 3.8 seconds. So you better get
//         it from the cache within less than 1 second.
//       2 setting certain values does not make sense and you should not
//         try to do so. Why would you want to set the current or the
//         voltage? They are measurements and should actually not be
//         writable at all
//       3 setting the alarm and provoking and alarm sound or resetting
//         the alarm simply does not work.
//       4 what makes sense is to do a better calculation of the SOC and
//         the TTG. They need to be updated regularly because the BMV
//         algorithm makes them drift off quickly with its own calculations.
//         These calculations of the state of charge are not very accurate.
//         I was always above 90% even if the battery was choking.
//         Setting SOC and TTG is demonstrated here.
//
//       For reason 2 above you will not find an implementation of the
//       following setters:
//       0xED8D 'V'
//       0xED8F 'I'
//       0xED8E 'P'
//       0x0382 'VM'
//       0x030E 'H15'
//       0x030F 'H16'
//
//       For reason 1 getters are only implemented for values that
//       are not delivered with the 1-second-update package. I.e.
//       the following:


class RegularUpdateChecksum {
    constructor() {
	logger.trace('RegularUpdateChecksum::RegularUpdateChecksum');
	this.reset();
    }

    reset() {
	logger.trace('RegularUpdateChecksum::reset');
	this.checksum = 0;
    }
    
    update(line) {
	logger.trace('RegularUpdateChecksum::update');
	let res = line.split("\t");
	
	// each frame starts with a linefeed and carriage return
	// they are swollowed by readline('\r\n')
	this.checksum += '\n'.charCodeAt(0);
	this.checksum += '\r'.charCodeAt(0);
	
	let c;
	// count all characters as uint8_t from first
	// value pair name until and including Checksum - tab- and the
	// uint8_t checksum value. Also include all the tabs between
	// name and value pair and the \n and \r after each line.
	// This checksum must be 0 (% 256)

	let lineLength = line.length;
	if (res[0] === "Checksum")
	{
            lineLength = res[0].length + 2; // plus \t and the checksum value
	}
	for (c = 0; c < lineLength; ++c)
	{
            this.checksum += line.charCodeAt(c);
	}
	return this.checksum;
    }

    get() {
	logger.trace('RegularUpdateChecksum::get');
	return this.checksum;
    }
}


function updateValuesAndValueListeners(doLog) {
    logger.trace('updateValuesAndValueListeners');
    let mapOfChanges = {};
    for (const [key, obj] of Object.entries(map)) {
        if (obj.newValue != null && obj.value !== obj.newValue)
        {
            let oldValue = obj.value;
            obj.value = obj.newValue; // accept new values
            // send event to listeners with values
            // on() means if update applied,
            
            if (obj.on !== null) // && Math.abs(obj.value - obj.newValue) >= obj.precision)
            {
                obj.on(obj.newValue, oldValue, obj.precision, packageArrivalTime);
            }
	    mapOfChanges[key] = new Object();
	    mapOfChanges[key].newValue  = obj.newValue;
	    mapOfChanges[key].oldValue  = oldValue;
	    mapOfChanges[key].precision = obj.precision;
            if (doLog) logger.debug(obj.shortDescr
                                    + " = " + oldValue
                                    + " updated with " + obj.newValue);
        }
        obj.newValue = null;
    }
    // FIXME: enable once updateValuesAndValueListeners is member of class VitronEl....
    //if (this.on !== null) this.on(mapOfChanges, packageArrivalTime);
}

function discardValues() {
    logger.trace('discardValues');
    // FIXME: should only discard values that are coming from regular updates
    for (const [key, obj] of Object.entries(map)) {
        obj.newValue = null; // dump new values
    } 
}

function isCommandValid(cmd) {
    logger.trace('isCommandValid');
    // colon : was swallowed by split(':')
    var rcs = append_checksum(":" + cmd.substring(0, cmd.length-2));
    var expectedCS = rcs.substring(rcs.length-2, rcs.length);
    var actualCS   = cmd.substring(cmd.length-2, cmd.length);
    if (actualCS !== expectedCS)
    {
        logger.error("ERROR: command checksum: " + actualCS
                    + " - expected: " + expectedCS);
        return false;
    }
    return true;
}

// \brief Creates the endianess needed by the device
// \detail The bytes of the incoming hex string's words are
//         filled with leading 0 and swapped
//         e.g. 0xBCD becomes 0xCD0B
// \param  hexStr the number as string in hexadecimal format (no leading 0x)
// \param  lengthInBytes of the number
// \pre    hexStr's length must be even!
function endianSwap(hexStr, lengthInBytes)
{
    logger.trace('endianSwap');
    while (hexStr.length < 2 * lengthInBytes)
    {
        hexStr = '0' + hexStr;
    }
    if (hexStr.length >= 4)
        hexStr = hexStr.substring(2, 4) + hexStr.substring(0, 2);
    if (hexStr.length >= 8)
        hexStr = hexStr.substring(6, 8) + hexStr.substring(4, 6);
    if (hexStr.length >= 12)
        logger.warn("endianSwap() not implemented for 12 bytes");
    return hexStr.toUpperCase();
}


function processCommand(cmd) {
    cmd = cmd.split('\n')[0];
    logger.trace("processCommand: response received " + cmd);

    if (!isCommandValid(cmd)) return;

    var cmdRegisterPrefix = cmd.substring(0, 5); // has no leading :
    // FIXME: remove next line - just for checking what substring(0,5) is supposed to do
    logger.trace("processCommand: response received " + cmdRegisterPrefix);
    if (cmdRegisterPrefix in responseMap && responseMap[cmdRegisterPrefix] !== undefined)
    {
        clearTimeout(responseMap[cmdRegisterPrefix].timerId)
        logger.debug(cmdRegisterPrefix + " in responseMap ==> clear timeout");
        // the standard parser splits line by '\r\n'
        // while a command response ends with '\n' only. 
        // I.e. there may be a chunk of stuff after the \n 
        // that needs to be split away.
        responseMap[cmdRegisterPrefix].func(cmd);
    }
    else if (cmdRegisterPrefix[0] === "5" || // 5: reply to ping
	     cmdRegisterPrefix[0] === "1")   // 1: reply to app version 
    {
	// TODO: assert(cmdRegisterPrefix.length > 4)
	// returns e.g. 5 05 43 (without spaces) ==> value = 0x4305 ==> version 3.05
	// or returns e.g. 1 05 43 for app version call
	let value = endianSwap(cmdRegisterPrefix.substring(1, cmdRegisterPrefix.length), 2);
	if (value[0] === "4") {
	    let version = value[1] + "." + value.substring(2, 4);
	    logger.info("Device software version " + version);
	}
	else logger.warn("Invalid reply to ping: " + cmdRegisterPrefix);
        // CS is 0x55 - where and when is it tested?
    }
    else if (cmdRegisterPrefix === "40000") // reply after restart
    {
        logger.debug("restart successful");
    }
    else if (cmdRegisterPrefix === "AAAA")
    {
        logger.error("Framing error");
    }
    else
    {
        logger.warn("unwarrented command " + cmdRegisterPrefix + " received - ignored");
    }
    // TODO: check regularly for left overs in responseMap and cmdMessageQ
}

var packageArrivalTime = 0;
var checksum = new RegularUpdateChecksum();

function parse_serial(line) {
    logger.trace('parse_serial');
    let res = line.split("\t");
    if (!res[0] || res[0] === "") return; // empty string
   
    if (res[0] === "Checksum")
    {
	// Calculating checksum of "Checksum\t" (word Checksum + tab)
	//
	//              C  h   e   c  k   s   u   m   \t
	// ASCII value: 67+104+101+99+107+115+117+109+11 = 828
	//
	// Looking at the oldCS and the expectedCS after receiving "Checksum\t":
	//
	// (oldCS + 828 + expectedCS) % 256 === 0!
	// ==> (oldCS % 256) + (828 % 256) + expectedCS === 0 (expectedCS < 256)
	// ==> expectedCS = -(oldCS % 256) - 60
	//                = 256 - (oldCS % 256) + 196  
	let expectedCS = (256 - (checksum.get() % 256) + 196) % 256; // Checksum+\t
	if (expectedCS < 0) { expectedCS = expectedCS + 256; }

	let cs = checksum.update(line);
        cs = cs % 256;
        if (cs === 0) // valid checksum for periodic frames
        {
            updateValuesAndValueListeners(false);
        }
        else // checksum invalid
        {
            discardValues();
	    const outStr = "data set checksum: " 
                  + res[1].charCodeAt(0).toString(16) + ' ('
                  + res[1].charCodeAt(0)
                  + ") - expected: " + expectedCS.toString(16)
                  + ' (' + expectedCS + ')';
	    if (res[1].length === 0) 
		logger.error("data set checksum: " 
                             + res[1].charCodeAt(0).toString(16) + ' ('
                             + res[1].charCodeAt(0)
                             + ") - expected: " + expectedCS.toString(16)
                             + ' (' + expectedCS + ')');
	    else
		logger.warn("data set checksum: " 
                             + res[1].charCodeAt(0).toString(16) + ' ('
                             + res[1].charCodeAt(0)
                             + ") - expected: " + expectedCS.toString(16)
                             + ' (' + expectedCS + ')');
        }
	packageArrivalTime = 0;
        checksum.reset(); // checksum field read => reset checksum
        // frame always finishes before another frame
        // or before a command response arrives.
        // Check for command response now:

        if (res[1].length === 0) return;
        // checksum value is followed by optional garbage and
        // optional command response all in res[1].
        // First char of res[1] contains checksum value so start from 1:
        var cmdSplit = res[1].substring(1, res[1].length).split(':');
        // none, one or several command responses can follow a frame.
        // Command responses always start with : and end with \n.
        var cmdIndex;
        for (cmdIndex = 1; cmdIndex < cmdSplit.length; ++cmdIndex) {
            processCommand(cmdSplit[cmdIndex]);
        }
    }
    else
    {
	checksum.update(line);
        if (res[0] === undefined) return;
	if (packageArrivalTime === 0) packageArrivalTime = new Date();
        if (res[0] in map && map[res[0]] !== undefined) map[res[0]].newValue = res[1];
        else logger.warn("parse_serial: " + res[0] + " is not registered and has value " + res[1]);
    }
};



// \pre cmd must be a command without the checksum i.e. start with : and
//      be hexadecimal
function append_checksum(cmd) {
    logger.trace('append_checksum');
    var command = "0" + cmd.substring(1, cmd.length);

    const byteInHex = command.split('').map(c => parseInt(c, 16));
    var checksum = byteInHex.reduce((total, hex, index) =>
                    (index % 2 === 0 ? total + hex * 16 : total + hex), 0);
    checksum = (0x55 - checksum) % 256;
    if (checksum < 0) checksum += 256;
    return cmd + ("0" + checksum.toString(16)).slice(-2).toUpperCase();
}


// move declaration into class CommandMessageQ
var responseMap = {};

// \param address is a string and has the format 0x???? (uint16 with leading zeros if needed)
// \param value as string, little endianed and filled with 0 from the left
function createMessage(cmd, address, value) {
    logger.trace('createMessage');
    logger.debug("===================================");
    logger.debug("cmd:          " + cmd);
    logger.debug("address:      " + address);
    logger.debug("value:        " + value);
    // remove 0x prefix
    const flag = '00'; // flag always 00 for outgoing get and set
    const leAddress = address.substring(4, 6) + address.substring(2, 4) // address in little endian
    //FIXME: value needs to be endian "swapped"
    let command = ':' + cmd + leAddress + flag + value;
    command = append_checksum(command) + '\n';
    return command;
}

// \param response without leading : and trailing \n
function messageState(response) {
    logger.trace('messageState');
    const state = parseInt(response.substring(5, 7));
    switch (state) {
    default:
    case 0: // OK
        break;
    case 1: // Unknown ID
        logger.error("Specific Id " + id + "does not exist");
        break;
    case 2: // Not supported
        logger.error("Attempting to write to a read only value at " + id);
        break;
    case 4: // Parameter Error
        logger.error("The new value " + value + " of " + id + " is out of range or inconsistent");
        break;
    }
    return state;
}

var sendMessageDeferTimer = null;


setTimeout( function() 
    { 
        //get("0xED8D"); // V - ok
        // get('0xED7D'); // 'VS'; response: -1 or FFFF
        //get('0xED8F'); // 'I' - ok
        // get('0xED8C'); // 'I'; existiert nicht - Error flag 01 unknown ID
        //get('0xED8E'); // 'P' - ok
        //get('0xEEFF'); // 'CE' -ok

        // todo : continue from here:
        // get('0x0FFF'); // 'SOC'
        //get('0x0FFE'); // 'TTG'; ok
        // get('0xEDEC'); // 'T'; response 65535 or FFFF, bmvdata = null

        //get('0x0382'); // 'VM' - ok
        //get('0x0383'); // 'DM'; diff by factor 10
        //get('0xEEB6'] = 'SOC' - ok

        //get('0x0300'); // H1 - ok
        //get('0x0301');   // H2 - ok
        //get('0x0302'); // H3 - ok
        //get('0x0303'); // H4 - ok
        //get('0x0304'); // H5 - ok 
        //get('0x0305'); // H6 - ok
        //get('0x0306'); // H7 - ok
        //get('0x0307'); // H8 - ok
        //get('0x0308'); // H9 - ok
        //get('0x0309'); // H10 was 0 test again
        //get('0x030A'); // H11 was 0 test again


        //get('0x030B'); // H12 was 0 test again
        //get('0x030E'); // H15 - ok
        //get('0x030F'); // H16 - ok
        //get('0x0310'); // H17 - ok
        //get('0x0311'); // H18 - ok

        //get('0x0100'); // product id (ro) - long string with 0000...00402FE 
        //get('0x0101'); // product revision (ro) - ERROR: 01 i.e. unknown; only for BMV-712
        //get('0x010A'); // serial no (ro) - ok - nicht decodiert
        //get('0x010B'); // model name (ro) - how to read? all hex: 70B0100424D562D37303297
        //get('0x010C'); // description - ERROR: 01; only for BMV-712
        //get('0x0120'); // device uptime (ro)
        //get('0x0150'); // bluetooth capabilities - ERROR 01

        // seems one can send 2 commands that reply with 32 bit
    } , 10100 ) ;

////////////////////////////////////////////////////////////////////////////////////////
//
// Getting a value takes in average 4seconds while many values update the device cache
// every 1 second. Hence it does not make sense to get values that are sent by the
// device.
//

// getUpperVoltage is better retrieved from the deviceCache via 'V'.
// Retrieving any value via get() takes in avg 3800ms while all
// updates of values are send every 1 second.
// exports.getUpperVoltage = function()
// {
//     get("0xED8D");
// }

// setUpperVoltage is better not performed to avoid simultaneous
// write issues inside the device. The only values that should
// be allowed to change are the History data 'H1', 'H2', 'H3' ...
// exports.setUpperVoltage = function(voltage)
// {
//     voltage = Math.round(100 * voltage);
//     strVoltage = voltage.toString(16); // hexadecimal
//     // FIXME: fill with 0 at left
//     strVoltage = strVoltage.substring(2, 4) + strVoltage.substring(0, 2);
//     set("0xED8D", strVoltage);
// }


// \param value is a integer
// \param lengthInBytes is the number of hexadecimal bytes returned
// \return values representation in hexadecimal system and bytes in
//         words swapped
function toEndianHexStr(value, lengthInBytes)
{
    logger.trace('toEndianHexStr');
    let str = "0";
    if (value != null && value != undefined) str = value.toString(16); // hexadecimal
    str = endianSwap(str, lengthInBytes);
    return str;
}





//:74F030000FC
// relay is dflt






// var readline = require('readline');

// var myInterface = readline.createInterface({
//   input: fs.createReadStream('serial-test-data', {encoding: 'binary'})
// });

// myInterface.on('line', function (line) {
//     map_components();
//     parse_serial(line);
// });

// \class CommandMessageQ is a queue of messages that contain commands
// \brief a message is composed of the command and its parameters
// \detail the command is the first 6 characters of a message
class CommandMessageQ {

    constructor(){
	logger.trace('CommandMessageQ::CommandMessageQ');
	this.cmdMessageQ = [];
	this.sendMessageDeferTimer = null;
	this.deferalTimeInMs = 1000;
	// measured avg response time approx. 3873ms
	this.cmdResponseTimeoutMS = 6000; // milliseconds
	this.cmdMaxRetries = 3;
	// two subsequent messages with the same command (and possible different
	// parameters) are "compressed" into one command with the parameters of
	// the second message
	this.cmdCompression = true;
	this.open('/dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE1SUT80-if00-port0');
    }

    setCmdCompression(value)
    {
	logger.trace('CommandMessageQ::setCmdCompression');
	this.cmdCompression = value;
    }

    restart() {
    	logger.trace("CommandMessageQ::restart");
    	this.port.write(':64F\n'); 
    }

    responseTimeoutHandler(cmdFrame) {
	logger.trace('CommandMessageQ::responseTimeoutHandler');
	const cmdRegisterPrefix = cmdFrame.substring(1, 6);
	logger.error("timeout - no response to "
                     + cmdFrame + " within "
                     + this.cmdResponseTimeoutMS + "ms");
	if (cmdRegisterPrefix in responseMap && responseMap[cmdRegisterPrefix] !== undefined)
	{
            if (responseMap[cmdRegisterPrefix].doRetry <= 0)
            {
		// FIXME: don't delete but mark as timedout in case message still arrives
		delete responseMap[cmdRegisterPrefix]; // ==> responseMap[cmdRegisterPrefix] == undefined
		//reject(new Error('timeout - no response received within 30 secs'));
		this.cmdMessageQ.shift(); // finished work on this message - dump
		logger.debug("Cmd Q: " + this.cmdMessageQ.length);
		this.restart(); // FIXME: after restart the following response received: 4000051
            }
            else if (this.cmdMessageQ.length > 0)
            {
		//this.restart();
		logger.debug("Repeating command ("
                             + responseMap[cmdRegisterPrefix].doRetry + ") "
                             + this.cmdMessageQ[0].substring(0, this.cmdMessageQ[0].length-1));
            }
	}
	if (this.cmdMessageQ.length > 0)
	{
            const nextCmd = this.cmdMessageQ[0];
            logger.debug("Send next command in Q: " + nextCmd.substring(0, nextCmd.length-1));
            this.runMessageQ();
	}
    }

    // \param response received from port without leading : and trailing \n
    messageState(response) {
	logger.trace('CommandMessageQ::messageState');
	const state = parseInt(response.substring(5, 7));
	switch (state) {
	default:
	case 0: // OK
            break;
	case 1: // Unknown ID
            logger.error("Specific Id " + id + "does not exist");
            break;
	case 2: // Not supported
            logger.error("Attempting to write to a read only value at " + id);
            break;
	case 4: // Parameter Error
            logger.error("The new value " + value + " of " + id + " is out of range or inconsistent");
            break;
	}
	return state;
    }


    responseHandler(response) {
	logger.trace("CommandMessageQ::responseHandler(" + response + ")");
	// response contains the message without leading : and trailing \n
	let lastCmdQIndex;
	for (lastCmdQIndex = 0; lastCmdQIndex < this.cmdMessageQ.length; ++lastCmdQIndex)
	{
	    if (response.substring(0, 5) === this.cmdMessageQ[lastCmdQIndex].substring(1, 6))
	    {
		break; // jump out of the loop without increasing i
	    }
	}
	if (lastCmdQIndex === this.cmdMessageQ.length)
	{
	    logger.error("response " + response
			 + " does not map any queued command: ");
	    if (this.cmdMessageQ.length === 0)
		logger.error("MessageQ empty");
	    else {
		for (lastCmdQIndex = 0; lastCmdQIndex < this.cmdMessageQ.length; ++lastCmdQIndex)
		{
		    // FIXME: remove last char in cmdMessageQ[] because it is \n
		    logger.error(this.cmdMessageQ[lastCmdQIndex]);
		}
	    }
	    return -2;
	}
	// check flag
	let flag = "00";
        if (this.messageState(response) !== 0) return -1;
        let strValue = response.substring(7, response.length-2);
        let valuesNumberOfBytes = strValue.length/2;
        strValue = endianSwap(strValue, valuesNumberOfBytes);
        logger.debug("endianed hex value: " + strValue);
        const address = "0x" + response.substring(3, 5) + response.substring(1, 3);
        if (address in addressCache)
        {
	    addressCache[address].newValue = addressCache[address].fromHexStr(strValue);
	    logger.debug("response for "
                         + addressCache[address].shortDescr + ' (old: ' +
                         + addressCache[address].value + ") - new value: " +
                         + addressCache[address].newValue);
	    //copied from updateValuesAndValueListeners(true); since it cannot be used !!! causes issues
	    if (addressCache[address].value !== addressCache[address].newValue)
	    {
                let oldValue = addressCache[address].value;
                addressCache[address].value = addressCache[address].newValue; // accept new values
                // send event to listeners with values
                // on() means if update applied,
		
                if (addressCache[address].on !== null) // && Math.abs(obj.value - obj.newValue) >= obj.precision)
                {
		    addressCache[address].on(addressCache[address].newValue, oldValue, addressCache[address].precision, packageArrivalTime);
                }
                addressCache[address].newValue = null;
	    }
        }
        else {
	    logger.warn(address + " is not in addressCache");
	    // FIXME: the creation of a new object? Does it make sense?
	    addressCache[address] = new Object();
	    addressCache[address].newValue = conv.hexToUint(strValue);
        }
	//TODO: if response does not match expected response sendMsg(message, priority) again.
	const lastCmd = (this.cmdMessageQ.splice(lastCmdQIndex, 1))[0]; // finished work on this message - dump
	// take last char off which is \n
	logger.debug(lastCmd.substring(0, lastCmd.length-1) + "\\n processed - dequeing");
	logger.debug("Cmd Q: " + this.cmdMessageQ.length);
	delete responseMap[response.substring(0, 5)];
	this.runMessageQ();
    }

    getResponse(cmdFrame) {
	logger.trace("CommandMessageQ::getResponse(" + cmdFrame + ")");
	let that = this;
	return new Promise(function(resolve, reject)
			   {
			       // cmdRegisterPrefix is without leading : and ending \n
			       let cmdRegisterPrefix = cmdFrame.substring(1, 6);
			       logger.debug("Adding " + cmdRegisterPrefix + " to reponseMap");

			       //var tid = setTimeout(this.responseTimeoutHandler, this.cmdResponseTimeoutMS, cmdFrame);
			       const tid = setTimeout(
				   function(cmdFrame) // do these params need bind?
				   {
				       that.responseTimeoutHandler(cmdFrame);
				   }, that.cmdResponseTimeoutMS, cmdFrame);

			       logger.debug("Timeout set to " + that.cmdResponseTimeoutMS
					    + "ms for " + cmdRegisterPrefix);
			       let newRetries = that.cmdMaxRetries;
			       if (cmdRegisterPrefix in responseMap && responseMap[cmdRegisterPrefix] != undefined)
				   newRetries = responseMap[cmdRegisterPrefix].doRetry-1;
			       responseMap[cmdRegisterPrefix] = {
				   func:    resolve.bind(this),
				   timerId: tid,
				   doRetry: newRetries,
			       };
			       that.port.write(cmdFrame);
			       logger.debug(cmdFrame.substring(0, cmdFrame.length-1)
					    + " sent to device");
			   });
    }

    // \detail starts or continues working the commands in the message Q
    //         if serial port is operational and Q is not empty.
    runMessageQ()
    {
	logger.trace('CommandMessageQ::runMessageQ');
	if (this.cmdMessageQ.length > 0) {
            if (isSerialOperational)
            {
		if (this.sendMessageDeferTimer != null) {
                    clearTimeout(this.sendMessageDeferTimer);
		}
		const nextCmd = this.cmdMessageQ[0];

		// TODO:
		// const address = "0x" + nextCmd.substring(4, 6) + nextCmd.substring(2, 4);
		// const value = nextCmd.substring(6, nextCmd.length-2);
		// // TODO: endianian value
		// if (addressCache[address].value ==
		//  addressCache[address].fromHexStr(strValue)) // FIXME: does convert do the job?
		// {
		//  logger.debug("Cached value same as command value - ignoring");
		//  return;
		// }

		logger.debug("Sending " + nextCmd.substring(0, nextCmd.length-1));
		this.getResponse(nextCmd).then(this.responseHandler.bind(this))
                    .catch(function(reject) {
			logger.warn("Reject: " + reject.message);
                    });
            }
            else
            {
		let multipleStr = "";
		if (this.sendMessageDeferTimer === null) // first deferal
		{
		    logger.debug("Port not yet operational");
		    multipleStr = "first time ";
		} else {
		    multipleStr = "another time ";
		}
                logger.debug("==> message deferred " + multipleStr + "by "
			     + this.deferalTimeInMs + " milliseconds");
		clearTimeout(this.sendMessageDeferTimer);
                //sendMessageDeferTimer = setTimeout(this.runMessageQ, 1000, true ) ;
                this.sendMessageDeferTimer = setTimeout(function()
						   {
						       this.runMessageQ();
						   }.bind(this), this.deferalTimeInMs);
		// else a new message came in but port not yet operational
		// ==> don't start another timer
            }
	}
	else
            logger.debug("MessageQ empty");
    }

    // \param  message consisting of a command and parameters
    // \return the command part of the message
    command(message) {
	return message.substring(0, 6);
    }
    
    // \param message is a command starting with : and ending with the checksum
    // \param priority is 0 or 1, 1 is prefered execution,
    //        if no priority is given 0 is assumed
    Q_push_back(message, priority) {
	logger.trace('CommandMessageQ::Q_push_back');
	const l = this.cmdMessageQ.length;

	if (priority !== undefined && priority === 1)
	{
            if (l > 1) // insert message between 1st and 2nd array element
            {
		logger.debug("Prioritizing " + message);
		// first is currently executed --> leave at position 0
		let first = this.cmdMessageQ.shift();
		// insert message at position 1
		this.cmdMessageQ.unshift(first, message);
		// it is possible that this.cmdMessageQ and message are the same command
		// (with same or different parameters). However we cannot compress
		// because we do not know at which execution state this.cmdMessageQ[0] is.
            }
            else // l == 0 or 1
            {
		this.cmdMessageQ.push(message);
            }
	    logger.debug("Cmd Q: " + this.cmdMessageQ.length);
            return;
	}
	// check: current command is same as previous but with possibly different
	//        parameter ==> if cmdCompression, execute only current command and
	//        skip previous
	if (this.cmdCompression
	    // l > 1: must not touch command at pos 0 because it is executed
            && (l > 1) && (this.command(this.cmdMessageQ[l-1]) == this.command(message)))
	{   // replace last command with possibly different params
            this.cmdMessageQ[l-1] = message;
            logger.debug("Command compression: Last cmd in Q replaced: " + this.cmdMessageQ.length);
	}
	else
	{
            // never execute the very same command with same parameters
	    // twice as it is like bouncing
            if (l === 0 || this.cmdMessageQ[l-1] != message)
            {
		this.cmdMessageQ.push(message);
		logger.debug("Cmd Q: " + this.cmdMessageQ.length);
            }
            else
            {
		logger.debug("Repeated message ignored: " + message);
            }
	}
    }


    // \details
    //   - Puts the message into the Q
    //   - Starts the Q if not yet running
    //   - Sets a timeout timer after which the first Q element is removed
    // \param message containing a command and parameters
    // \param priority in [0; 1]; default 0; 0 = normal, 1 = prioritized (send next)
    // \param timeoutInMs in milliseconds after which the message is removed from Q;
    //        if unspecified or 0, do not remove message from Q after timeout
    sendMsg(message, priority, timeoutInMs) {
	message = message.toUpperCase();
	logger.trace('CommandMessageQ::sendMsg: ' + message.substring(0, message.length-1) + "\\n");
	const isQEmpty = (this.cmdMessageQ.length === 0); // must be set before Q_push_back

	if (timeoutInMs === undefined)
	    timeoutInMs = 2 * (this.cmdMaxRetries + 1) * this.cmdResponseTimeoutMS;
	if (timeoutInMs === 0)
	    // this.cmdMaxRetries = MAX_SAFE_INTEGER not defined
	    this.cmdMaxRetries = 999999;
	 	
        this.Q_push_back(message, priority);
	if (isQEmpty)
	{
            // TODO: this.cmdMessageQ empty ==> clear responseMap
            this.runMessageQ();
	}
	else if (timeoutInMs !== 0)
	{
	    // set timer after which the first Q element is removed
	    
            // FIXME: message times out and is removed from responseMap but then
            //        may still arrive (not being found in repsonseMap -> TODO: timeoutmap???
            // FIXME: 2 or more same commands fired right after each other with
            //        cmdCompression switched off ==> only one responseMap entry
            //        while it should be 2 or more, i.e. 1 response deletes
            //        this entry and later incoming don't work
            let firstCmdInQ = this.cmdMessageQ[0];
	    // set timeout after which the first command in the Q is removed
            setTimeout(function()
		       {
			   if (this.sendMessageDeferTimer !== null) {
			       clearTimeout(this.sendMessageDeferTimer);
			   }
			   // if after the max timeout firstCmdInQ is still the first in Q
			   if (firstCmdInQ === this.cmdMessageQ[0])
			   {
			       // FIXME: firstCmdInQ could match a later cmd in Q which
			       //        is not in pos 0
			       // FIXME: remove last char of firstCmdInQ because it is \n
			       logger.warn(firstCmdInQ + " timed out ==> removing from Q");
			       this.cmdMessageQ.shift(); // remove firstCmdInQ from Q
			       delete responseMap[fristCmdInQ.substring(1, 6)];
			       this.runMessageQ();
			   }
		       }.bind(this), timeoutInMs);
	}
    }

    sendSimpleCommand(cmd, expectedResponse) {
	logger.trace('CommandMessageQ::sendSimpleCommand');
	var command = ':' + cmd;
	command = append_checksum(command) + '\n';
	logger.debug("===================================");
	logger.debug("send command: " + command);
	
	this.getResponse(command).then((response) => {
		// resolve contains the command without leading : and trailing \n
		logger.debug("Response: " + response);

		if (response !== undefined
                    && response.substring(1, 2) == expectedResponse) {
                    var strValue = response.substring(2, response.length-2);
                    strValue = strValue.substring(2, 4) + strValue.substring(0, 2);
                    logger.debug("Response value: " + strValue);
		}
		else logger.debug("Response is undefined or unexpected");
            })
            .catch((reject) => {
		logger.debug("Reject: " + reject.message);
            });
    }

    open(ve_port) {
	logger.trace('CommandMessageQ::open(.)');
        this.port =  new serialport(ve_port, {
            baudrate: 19200,
            parser: serialport.parsers.readline('\r\n', 'binary')});
        this.port.on('data', function(line) {
            isSerialOperational = true;
            if (this.isRecording)
            {
                record_file.write(line + '\r\n');
            }
            parse_serial(line);
        });
    }

    close() {
	logger.trace('CommandMessageQ::sendSimpleCommand');
        console.log("closing port");
        port.close();
    }


}




class VitronEnergyDevice {

    constructor(){
	logger.trace('VitronEnergyDevice::VitronEnergyDevice');
        // set isRecording true to record the incoming data stream to record_file
        this.isRecording = false;
	this.cmdMessageQ = [];
	this.on = null;
        if(! VitronEnergyDevice.instance){
	    this.cmdQ = new CommandMessageQ();
            //this.open('/dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE1SUT80-if00-port0');
            VitronEnergyDevice.instance = this;
        }
        return VitronEnergyDevice.instance;
    }


    restart() {
	logger.trace('VitronEnergyDevice::restart');
	this.cmdQ.restart();
    }
	
    get(address, priority, timeoutInMs) {
	logger.trace('VitronEnergyDevice::get(address): ' + address);
	const message = createMessage('7', address, '');
	this.cmdQ.sendMsg(message, priority, timeoutInMs);
    }

    // \param value must be a string of 4 or 8  characters in hexadecimal
    //        with byte pairs swapped, i.e. 1B83 => 831B
    set(address, value, priority, timeoutInMs) {
	logger.trace('VitronEnergyDevice::set(address): ' + address);
	const message = createMessage('8', address, value);
	this.cmdQ.sendMsg(message, priority, timeoutInMs);
    }

    // EEE functions (switch on/off display values)
    // FIXME: the following shown functions need addressCache to be created before calling them
    isVoltageShown()
    {
	logger.trace('VitronEnergyDevice::isVoltageShown: ' + address);
	get("0xEEE0");
    }

    setStateOfCharge(soc)
    {
	logger.trace('VitronEnergyDevice::setStateOfCharge: ' + soc);
        if (soc < 0 || soc > 100)
        {
            logger.debug('soc out of range: ' + soc);
            return;
        }
        soc = Math.round(100 * soc);
        let strSoc = toEndianHexStr(soc, 2);
        logger.debug("setSOC: " + soc + " as hex-string " + strSoc);
        this.set("0x0FFF", strSoc); // FIXME: this goes wrong if strSOC = "0020" since that becomes 20 inside set
    }

    getStateOfCharge()
    {
	logger.trace('VitronEnergyDevice::getStateOfCharge: ' + address);
        this.get("0x0FFF");
    }

    setBatteryCapacity(capacity) {
        logger.trace("VitronEnergyDevice::setBatteryCapacity to " + capacity);

        let strCapacity = toEndianHexStr(capacity, 2);
        this.set("0x1000", strCapacity);
    };

    getBatteryCapacity()
    {
	logger.trace("VitronEnergyDevice::getBatteryCapacity");
	this.get("0x1000");
    }

    setChargedVoltage(voltage)
    {
        logger.trace("VitronEnergyDevice::setChargedVoltage to " + voltage);
        let strVoltage = toEndianHexStr(voltage, 2);
        this.set("0x1001", strVoltage);
    }

    getChargedVoltage()
    {
	logger.trace("VitronEnergyDevice::getChargedVoltage");
	this.get("0x1001");
    }

    setTailCurrent(current)
    {
        logger.trace("VitronEnergyDevice::setTailCurrent to " + current);
        let strCurrent = toEndianHexStr(current, 2);
        this.set("0x1002", strCurrent);
    }

    getTailCurrent()
    {
	logger.trace("VitronEnergyDevice::getTailCurrent");
	this.get("0x1002");
    }

    setChargedDetectTime(time)
    {
        logger.trace("VitronEnergyDevice::setChargedDetectTime to " + time);
        let strTime = toEndianHexStr(time, 2);
        this.set("0x1003", strTime);
    }

    getChargedDetectTime()
    {
	logger.trace("VitronEnergyDevice::getChargedDetectTime");
	this.get("0x1003");
    }


    setChargeEfficiency(percent)
    {
        logger.trace("VitronEnergyDevice::setChargeEfficiency to " + percent);
        let strPerc = toEndianHexStr(percent, 2);
        this.set("0x1004", strPerc);
    }

    getChargeEfficiency()
    {
	logger.trace("VitronEnergyDevice::getChargeEfficiency");
	this.get("0x1004");
    }

    setPeukertCoefficient(coeff)
    {
        logger.trace("VitronEnergyDevice::setPeukertCoefficient to " + coeff);
        let strCoeff = toEndianHexStr(coeff, 2);
        this.set("0x1005", strCoeff);
    }

    getPeukertCoefficient()
    {
	logger.trace("VitronEnergyDevice::getPeukertCoefficient");
	this.get("0x1005");
    }

    setCurrentThreshold(current)
    {
        logger.trace("VitronEnergyDevice::setCurrentThreshold to " + current);
        let strCurrent = toEndianHexStr(current, 2);
        this.set("0x1006", strCurrent);
    }

    // FIXME: feasble?
    getCurrentThreshold()
    {
	logger.trace("VitronEnergyDevice::getCurrentThreshold");
	this.get("0x1006");
    }

    setTimeToGoDelta(time)
    {
        logger.trace("VitronEnergyDevice::setTimeToGoDelta to " + time);
        let strTime = toEndianHexStr(time, 2);
        this.set("0x1007", strTime);
    }

    getTimeToGoDelta()
    {
	logger.trace("VitronEnergyDevice::getTimeToGoDelta");
	this.get("0x1007");
    }

    isTimeToGoShown()
    {
	logger.trace("VitronEnergyDevice::isTimeToGoShown");
	this.get("0xEEE6");
    }

    setShowTimeToGo(onOff)
    {
	logger.trace("VitronEnergyDevice::setShowTimeToGo to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE6", strOnOff);
    }

    isTemperatureShown() {
	logger.trace("VitronEnergyDevice::isTemperatureShown");
	this.get("0xEEE7");
    }

    setShowTemperature(onOff)
    {
	logger.trace("VitronEnergyDevice::setShowTemperature to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE7", strOnOff);
    }

    isPowerShown()
    {
	logger.trace("VitronEnergyDevice::isPowerShown");
	this.get("0xEEE8");
    }

    setShowPower(onOff)
    {
	logger.trace("VitronEnergyDevice::setShowPower to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE8", strOnOff);
    }

    setRelayLowSOC(percent)
    {
        logger.trace("VitronEnergyDevice::setRelayLowSOC to " + percent);
        let strPercent = toEndianHexStr(percent, 2);
        this.set("0x1008", strPercent);
    }

    getRelayLowSOC()
    {
	logger.trace("VitronEnergyDevice::getRelayLowSOC");
	this.get("0x1008");
    }

    setRelayLowSOCClear(percent)
    {
        logger.trace("VitronEnergyDevice::setRelayLowSOCClear to " + percent);
        let strPercent = toEndianHexStr(percent, 2);
        this.set("0x1009", strPercent);
    }

    getRelayLowSOCClear()
    {
	logger.trace("VitronEnergyDevice::getRelayLowSOCClear");
	this.get("0x1009");
    }

    setUserCurrentZero(count)
    {
        logger.trace("VitronEnergyDevice::setUserCurrentZero to " + count);
        let strCount = toEndianHexStr(count, 2);
        this.set("0x1034", strCount);
    }

    getUserCurrentZero()
    {
	logger.trace("VitronEnergyDevice::getUserCurrentZero");
	get("0x1034");
    }

    setShowVoltage(onOff)
    {
        logger.trace("VitronEnergyDevice::setShowVoltage to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE0", strOnOff);
    }

    isAuxiliaryVoltageShown()
    {
	logger.trace("VitronEnergyDevice::isAuxiliaryVoltageShown");
	get("0xEEE1");
    }
    
    setShowAuxiliaryVoltage(onOff)
    {
        logger.trace("VitronEnergyDevice::setShowAuxiliaryVoltage to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE1", strOnOff);
    }

    setShowMidVoltage(onOff)
    {
        logger.trace("VitronEnergyDevice::setShowMidVoltage to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE2", strOnOff);
    }

    isCurrentShown()
    {
	logger.trace("VitronEnergyDevice::isCurrentShown");
	this.get("0xEEE3");
    }

    isMidVoltageShown()
    {
	logger.trace("VitronEnergyDevice::isMidVoltageShown");
	this.get("0xEEE2");
    }

    setShowCurrent(onOff)
    {  
        logger.trace("VitronEnergyDevice::setShowCurrent to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE3", strOnOff);
    }

    setShowConsumedAh(onOff)
    {
	logger.trace("VitronEnergyDevice::setShowConsumedAh to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE4", strOnOff);
    }

    isConsumedAhShown()
    {
	logger.trace("VitronEnergyDevice::isConsumedAhShown");
	this.get("0xEEE4");
    }

    setShowStateOfCharge(onOff)
    {
	logger.trace("setShowStateOfCharge to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE5", strOnOff);
    }

    isStateOfChargeShown()
    {
	logger.trace("VitronEnergyDevice::isStateOfChargeShown");
	this.get("0xEEE5");
    }

    writeDeviceConfig(newCurrent, oldCurrent, precision, timestamp)
    {
	logger.trace("VitronEnergyDevice::writeDeviceConfig");
	// writeDeviceConfig is called by relayLowSOCClear's
	// on function. Until then updateValuesAndValueListeners
	// has written all newValue's to value with the exception
	// of 
	let config = {
            BatteryCapacity:    bmvdata.capacity.value,
            ChargedVoltage:     bmvdata.chargedVoltage.value,
            TailCurrent:        bmvdata.tailCurrent.value,
            ChargedDetectTime:  bmvdata.chargedDetectTime.value,
            ChargeEfficiency:   bmvdata.chargeEfficiency.value,
            PeukertCoefficient: bmvdata.peukertCoefficient.value,
            CurrentThreshold:   bmvdata.currentThreshold.value,
            TimeToGoDelta:      bmvdata.timeToGoDelta.value,
            RelayLowSOC:        bmvdata.relayLowSOC.value,
            RelayLowSOCClear:   bmvdata.relayLowSOCClear.value
	};
	logger.debug("Stringify to JSON format");
	let jsonConfig = JSON.stringify(config, null, 2);
	logger.debug(jsonConfig);
	let file = __dirname + '/config.json';
	logger.debug("Writing config to file " + file);

	let config_file = fs.createWriteStream(file, {flags: 'w'});
	config_file.write(jsonConfig);

	logger.debug("deleting listeners");
	// FIXME all these values are null, not undefined, why?
	if (bmvdata.capacity.value !== null)
            this.registerListener('capacity',           null);
        if (bmvdata.chargedVoltage.value !== null)
            this.registerListener('chargedVoltage',     null);
	if (bmvdata.tailCurrent.value !== null)
            this.registerListener('tailCurrent',        null);
	if (bmvdata.chargedDetectTime.value !== null)
            this.registerListener('chargedDetectTime',  null);
	if (bmvdata.chargeEfficiency.value !== null)
            this.registerListener('chargeEfficiency',   null);
	if (bmvdata.peukertCoefficient.value !== null)
            this.registerListener('peukertCoefficient', null);
	if (bmvdata.currentThreshold.value !== null)
            this.registerListener('currentThreshold',   null);
        if (bmvdata.timeToGoDelta.value !== null)
            this.registerListener('timeToGoDelta',      null);
	if (bmvdata.relayLowSOC.value !== null)
            this.registerListener('relayLowSOC',        null);
        if (bmvdata.relayLowSOCClear.value !== null)
            this.registerListener('relayLowSOCClear',   null);
    }

    getDeviceConfig(doSave)
    {
        logger.trace("VitronEnergyDevice::getDeviceConfig");

        if (doSave) {
            // prepare for saving the data:
            console.log("registering writeDeviceConfig listeners");
            this.registerListener('capacity',           this.writeDeviceConfig.bind(this));
            this.registerListener('chargedVoltage',     this.writeDeviceConfig.bind(this));
            this.registerListener('tailCurrent',        this.writeDeviceConfig.bind(this));
            this.registerListener('chargedDetectTime',  this.writeDeviceConfig.bind(this));
            this.registerListener('chargeEfficiency',   this.writeDeviceConfig.bind(this));
            this.registerListener('peukertCoefficient', this.writeDeviceConfig.bind(this));
            this.registerListener('currentThreshold',   this.writeDeviceConfig.bind(this));
            this.registerListener('timeToGoDelta',      this.writeDeviceConfig.bind(this));
            this.registerListener('relayLowSOC',        this.writeDeviceConfig.bind(this));
            this.registerListener('relayLowSOCClear',   this.writeDeviceConfig.bind(this));
        }

        this.getBatteryCapacity();
        this.getChargedVoltage();
        this.getTailCurrent();
        this.getChargedDetectTime();
        this.getChargeEfficiency();
        this.getPeukertCoefficient();
        this.getCurrentThreshold();
        this.getTimeToGoDelta();
        this.getRelayLowSOC();
        this.getRelayLowSOCClear();
    }

    // \param mode 0 = default, 1 = charge, 2 = remote
    set_relay_mode(mode) {
    	logger.trace("VitronEnergyDevice::set relay mode");
	// FIXME: set priority 1 (bug: currently not working)
	if (mode === 0)
	    this.set("0x034F", "00", 0, 0);
	else if (mode === 1)
	    this.set("0x034F", "01", 0, 0);
	else if (mode === 2)
	    this.set("0x034F", "02", 0, 0);
    }

    setRelay(mode) {
	// FIXME: prioritizing both set_relay_mode and then setRelay pushes
	//        the setRelay before setting the mode!!! Fix: save prioritization
	//        in cmdMessageQ and do not allow them being pushed.
        logger.trace("VitronEnergyDevice::set relay");
        this.set_relay_mode(2);
	// FIXME: set priority 1 (bug: currently not working)
        if (mode === 0)
            this.set("0x034E", "00", 0, 0);
        else
            this.set("0x034E", "01", 0, 0);
    }

    set_alarm() {
        logger.trace("VitronEnergyDevice::set alarm");
        this.set("0xEEFC", "01");
    }
    
    clear_alarm() {
        logger.trace("VitronEnergyDevice::clear alarm");
        //this.set("0xEEFC", "00");
        this.set("0x031F", "00");
    }

    ping() {
        logger.trace("VitronEnergyDevice::ping");
        //port.write(':154\n'); // ping
        this.cmdQ.sendSimpleCommand('1', '5');
        // returns :5 05 43 08 ==> 0x4305 ==> version 3.05
        // 5 = reply to ping
        // CS 0x55
    };

    app_version() {
        logger.trace("VitronEnergyDevice::app version");
        //port.write(':352\n'); // application version
        this.cmdQ.sendSimpleCommand('3', '1');
        // returns :1 05 43 0C ==> 0x4305 ==> version 3.05
        // 1 = Done
        // CS 0x55
    }

    productId() {
	logger.trace("VitronEnergyDevice::product id");
	this.cmdQ.sendSimpleCommand('4', '1');
	//port.write(':451\n'); // product ID
	// returns :1 04 02 4E ==> 0x0204 ==> version 0x204 ==> BMV 702
	// 1 = Done
	// CS 0x55
    }
    
    registerListener(bmvdataKey, listener)
    {
	logger.trace("VitronEnergyDevice::registerListener");
	if (bmvdataKey === "Checksum") this.on = listener;
        else bmvdata[bmvdataKey].on = listener;
    }
    
    hasListener(bmvdataKey)
    {
	logger.trace("VitronEnergyDevice::hasListener");
	if (bmvdataKey === "Checksum") return this.on !== null;
        else return bmvdata[bmvdataKey].on !== null;
    }

    update() {
	logger.trace("VitronEnergyDevice::update");
        return bmvdata;
    }
}

// ES6:
// const instance = new VitronEnergyDevice();
// export default instance;
module.exports.VitronEnergyDevice = new VitronEnergyDevice();
Object.freeze(exports.VitronEnergyDevice);

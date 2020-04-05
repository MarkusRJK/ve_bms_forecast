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
// - introduce force cmds that repeat + reset until done
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
    default: { appenders: [ 'everything' ], level: 'trace' }
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
// measured avg response time approx. 3873ms
const cmdResponseTimeoutMS = 5000; // 5 seconds
const cmdMaxRetries = 3;

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

// var checksum = 0;

// function updateChecksum(line) {
//     let res = line.split("\t");

//     // each frame starts with a linefeed and carriage return
//     // they are swollowed by readline('\r\n')
//     checksum += '\n'.charCodeAt(0);
//     checksum += '\r'.charCodeAt(0);
    
//     let c;
//     // count all characters as uint8_t from first
//     // value pair name until and including Checksum - tab- and the
//     // uint8_t checksum value. Also include all the tabs between
//     // name and value pair and the \n and \r after each line.
//     // This checksum must be 0 (% 256)

//     let lineLength = line.length;
//     if (res[0] === "Checksum")
//     {
//         lineLength = res[0].length + 2; // plus \t and the checksum value
//     }
//     else {
//     }
//     for (c = 0; c < lineLength; ++c)
//     {
//         checksum += line.charCodeAt(c);
//     }
//     return checksum;
// }

class RegularUpdateChecksum {
    constructor() {
	this.reset();
    }

    reset() {
	this.checksum = 0;
    }
    
    update(line) {
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
	//else {
	//}
	for (c = 0; c < lineLength; ++c)
	{
            this.checksum += line.charCodeAt(c);
	}
	return this.checksum;
    }

    get() {
	return this.checksum;
    }
}


function updateValuesAndValueListeners(doLog) {
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
    // FIXME: should only discard values that are coming from regular updates
    for (const [key, obj] of Object.entries(map)) {
        obj.newValue = null; // dump new values
    } 
}

function isCommandValid(cmd) {
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

function processCommand(cmd) {
    cmd = cmd.split('\n')[0];
    logger.trace("processCommand: response received " + cmd);

    if (!isCommandValid(cmd)) return;

    var cmdRegisterPrefix = cmd.substring(0, 5);
    if (cmdRegisterPrefix in responseMap && responseMap[cmdRegisterPrefix] !== undefined)
    {
        clearTimeout(responseMap[cmdRegisterPrefix].timerId)
        logger.debug(cmdRegisterPrefix + " in responseMap ==> clear timeout");
        // the standard parser splits line by '\r\n'
        // while a command response ends with '\n' only. 
        // I.e. there may be a chunk of stuff after the \n 
        // that needs to be split away.
        responseMap[cmdRegisterPrefix].func(cmd);
        delete responseMap[cmdRegisterPrefix];
    }
    else if (cmdRegisterPrefix == "40000") // reply after restart
    {
        logger.debug("restart successful");
    }
    else if (cmdRegisterPrefix == "AAAA")
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
            logger.error("ERROR: data set checksum: " 
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
    var command = "0" + cmd.substring(1, cmd.length);

    const byteInHex = command.split('').map(c => parseInt(c, 16));
    var checksum = byteInHex.reduce((total, hex, index) =>
                    (index % 2 === 0 ? total + hex * 16 : total + hex), 0);
    checksum = (0x55 - checksum) % 256;
    if (checksum < 0) checksum += 256;
    return cmd + ("0" + checksum.toString(16)).slice(-2).toUpperCase();
}


var responseMap = {};

// var priv_restart = function() {
//     logger.debug("restart");
//     port.write(':64F\n'); 
// };


// function get(address, priority) {
//     logger.debug("get address: " + address);
//     const message = createMessage('7', address, '');
//     sendMsg(message, priority);
// }

// // \param value must be a string of 4 or 8  characters in hexadecimal
// //        with byte pairs swapped, i.e. 1B83 => 831B
// function set(address, value, priority) {
//     logger.debug("set address: " + address);
//     const message = createMessage('8', address, value);
//     sendMsg(message, priority);
// }

// \param address is a string and has the format 0x???? (uint16 with leading zeros if needed)
// \param value as string, little endianed and filled with 0 from the left
function createMessage(cmd, address, value) {
    logger.debug("===================================");
    logger.debug("cmd:          " + cmd);
    logger.debug("address:      " + address);
    logger.debug("value:        " + value);
    // remove 0x prefix
    const flag = '00'; // flag always 00 for outgoing get and set
    leAddress = address.substring(4, 6) + address.substring(2, 4) // address in little endian
    //FIXME: value needs to be endian "swapped"
    let command = ':' + cmd + leAddress + flag + value;
    command = append_checksum(command) + '\n';
    return command;
}

// \param response without leading : and trailing \n
function messageState(response) {
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

// \brief Creates the endianess needed by the device
// \detail The bytes of the incoming hex string's words are
//         filled with leading 0 and swapped
//         e.g. 0xBCD becomes 0xCD0B
// \param  hexStr the number as string in hexadecimal format (no leading 0x)
// \param  lengthInBytes of the number
// \pre    hexStr's length must be even!
function endianSwap(hexStr, lengthInBytes)
{
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
    let str = "0";
    if (value != null && value != undefined) str = value.toString(16); // hexadecimal
    str = endianSwap(str, lengthInBytes);
    return str;
}





//:74F030000FC
// relay is dflt


// set_relay_mode = function(mode) {
//     logger.debug("set relay mode");
//     port.write(':84F030002F9'); // mode = 2 (rmt)
// }





// var readline = require('readline');

// var myInterface = readline.createInterface({
//   input: fs.createReadStream('serial-test-data', {encoding: 'binary'})
// });

// myInterface.on('line', function (line) {
//     map_components();
//     parse_serial(line);
// });





class VitronEnergyDevice {
    //port;
    constructor(){
        // set isRecording true to record the incoming data stream to record_file
        this.isRecording = false;
	this.cmdMessageQ = [];
	this.on = null;
        if(! VitronEnergyDevice.instance){
            this.open('/dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE1SUT80-if00-port0');
            VitronEnergyDevice.instance = this;
        }
        return VitronEnergyDevice.instance;
    }

    open(ve_port) {
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

    restart() {
	logger.debug("restart");
	this.port.write(':64F\n'); 
    }

    responseTimeoutHandler(cmdFrame, cmdRegisterPrefix) {
	logger.error("ERROR: timeout - no response to "
                     + cmdFrame + " within "
                     + cmdResponseTimeoutMS + "ms");
	if (cmdRegisterPrefix in responseMap && responseMap[cmdRegisterPrefix] !== undefined)
	{
            if (responseMap[cmdRegisterPrefix].doRetry <= 0)
            {
		delete responseMap[cmdRegisterPrefix];
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
            this.runMessageQ(false);
	}
    }

    getResponse(cmdFrame) {
	var that = this;
	return new Promise(function(resolve, reject)
			   {
			       // cmdRegisterPrefix is without leading : and ending \n
			       let cmdRegisterPrefix = cmdFrame.substring(1, 6);
			       logger.debug("Adding " + cmdRegisterPrefix + " to reponseMap");

			       //var tid = setTimeout(this.responseTimeoutHandler, cmdResponseTimeoutMS, cmdFrame, cmdRegisterPrefix);
			       var tid = setTimeout(
				   function(cmdFrame, cmdRegisterPrefix) // do these params need bind?
				   {
				       that.responseTimeoutHandler(cmdFrame, cmdRegisterPrefix);
				   }, cmdResponseTimeoutMS, cmdFrame, cmdRegisterPrefix);

			       logger.debug("Timeout set to " + cmdResponseTimeoutMS
					    + "ms for " + cmdRegisterPrefix);
			       let newRetries = cmdMaxRetries;
			       if (cmdRegisterPrefix in responseMap && responseMap[cmdRegisterPrefix] != undefined)
				   newRetries = responseMap[cmdRegisterPrefix].doRetry-1;
			       responseMap[cmdRegisterPrefix] = {
				   func:    resolve,
				   timerId: tid,
				   doRetry: newRetries,
			       };
			       that.port.write(cmdFrame);
			   });
    }

    sendSimpleCommand(cmd, expectedResponse) {
	var command = ':' + cmd;
	command = append_checksum(command) + '\n';
	logger.debug("===================================");
	logger.debug("send command: " + command);
	
	this.getResponse(command).then(
            function(response) {
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
            .catch(function(reject) {
		logger.debug("Reject: " + reject.message);
            });
    }

    responseHandler(response) {
	logger.debug("responseHandler(" + response + ")");
	// response contains the message without leading : and trailing \n
	if (response == "AAAA")
	{
            logger.error("framing error");
            return -1;
	}
	if (response.substring(0, 5) !== this.cmdMessageQ[0].substring(1, 6))
	{
            logger.error("response " + response
			 + " does not map queued command: "
			 + this.cmdMessageQ[0]);
            return -2;
	}
	// check flag
	let flag = "00";
	if (response !== undefined) {
            if (messageState(response) !== 0) return -1;
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
		addressCache[address] = new Object();
		addressCache[address].newValue = conv.hexToUint(strValue);
            }
	}
	else logger.warn("Response is undefined");
	//TODO: if response does not match expected response sendMsg(message, priority) again.
	const lastCmd = this.cmdMessageQ[0];
	// take last char off which is \n
	logger.debug(lastCmd.substring(0, lastCmd.length-1) + "\\n processed - dequeing");
	this.cmdMessageQ.shift(); // finished work on this message - dump
	logger.debug("Cmd Q: " + this.cmdMessageQ.length);
	this.runMessageQ(false);
    }

    runMessageQ(isTimeout)
    {
	if (this.cmdMessageQ.length > 0) {
            if (isSerialOperational)
            {
		if (sendMessageDeferTimer != null) {
                    clearTimeout(sendMessageDeferTimer);
                    //sendMessageDeferTimer = null;
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
		this.getResponse(nextCmd).then(this.responseHandler)
                    .catch(function(reject) {
			logger.warn("Reject: " + reject.message);
                    });
            }
            else
            {
		if (! isTimeout && this.cmdMessageQ.length === 1) {
                    logger.debug("==> sendMessage deferred by 1 second");
                    //clearTimeout(sendMessageDeferTimer);
                    //sendMessageDeferTimer = setTimeout(this.runMessageQ, 1000, true ) ;
		} else {
                    // if timeout happend the timer expired and we start a new one
                    logger.debug("==> deferred another time by 1 second");
                    //clearTimeout(sendMessageDeferTimer);
                    //sendMessageDeferTimer = setTimeout(this.runMessageQ, 1000, true ) ;
		}
		clearTimeout(sendMessageDeferTimer);
                sendMessageDeferTimer = setTimeout(function()
						   {
						       this.runMessageQ(true);
						   }.bind(this), 1000) ;
		// else a new message came in but port not yet operational
		// ==> don't start another timer
            }
	}
	else
            logger.debug("MessageQ empty");
    }

    // \param message is a command starting with : and ending with the checksum
    // \param priority is 0 or 1, 1 is prefered execution
    Q_push_back(message, priority) {
	const l = this.cmdMessageQ.length;

	if (priority !== undefined && priority === 1)
	{
            if (l > 0)
            {
		logger.debug("Prioritizing " + message);
		// first is currently executed --> leave at position 0
		let first = this.cmdMessageQ.shift();
		// insert message at position 1
		this.cmdMessageQ.unshift(first, message);
		// it is possible that this.cmdMessageQ and message are the same command
		// (with same or different parameters). However we cannot compress
		// because we do not know at which execution state this.cmdMessageQ[0] is.
		logger.debug("Cmd Q: " + this.cmdMessageQ.length);
            }
            else // l == 0
            {
		this.cmdMessageQ.push(message);
		logger.debug("Cmd Q: " + this.cmdMessageQ.length);
            }
            return;
	}
	// check: current command is same as previous but with possibly different
	//        parameter ==> if cmdCompression, execute only current command and
	//        skip previous
	if (cmdCompression
            && (l > 0) && (this.cmdMessageQ[l-1].substring(0, 6) == message.substring(0, 6)))
	{   // replace last command 
            this.cmdMessageQ[l-1] = message;
            logger.debug("Last cmd in Q replaced: " + this.cmdMessageQ.length);
	}
	else
	{
            // never execute the very same command twice as it is like bouncing
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

    sendMsg(message, priority) {
	message = message.toUpperCase();
	logger.trace("sendMsg: " + message.substring(0, message.length-1) + "\\n");

	if (this.cmdMessageQ.length === 0)
	{
            // TODO: this.cmdMessageQ empty ==> clear responseMap
            this.Q_push_back(message, priority);
            this.runMessageQ(false);
	}
	else
	{
            this.Q_push_back(message, priority);
            // FIXME: message times out and is removed from responseMap but then
            //        may still arrive (not being found in repsonseMap -> TODO: timeoutmap???
            // FIXME: 2 or more same commands fired right after each other with
            //        cmdCompression switched off ==> only one responseMap entry
            //        while it should be 2 or more, i.e. 1 response deletes
            //        this entry and later incoming don't work
            let firstCmdInQ = this.cmdMessageQ[0];
            setTimeout(function()
		       {
			   // if after the max timeout firstCmdInQ is still the first in Q
			   if (firstCmdInQ === this.cmdMessageQ[0])
			   {
			       // FIXME: firstCmdInQ could match a later cmd in Q which is no
			       //        in pos 0
			       this.cmdMessageQ.shift();
			       this.runMessageQ(false); // FIXME: this runs occassionally two msg in parallel
			   }
		       }.bind(this), 2 * (cmdMaxRetries + 1) * cmdResponseTimeoutMS);
	}
    }

    get(address, priority) {
	logger.debug("get address: " + address);
	const message = createMessage('7', address, '');
	this.sendMsg(message, priority);
    }

    // \param value must be a string of 4 or 8  characters in hexadecimal
    //        with byte pairs swapped, i.e. 1B83 => 831B
    set(address, value, priority) {
	logger.debug("set address: " + address);
	const message = createMessage('8', address, value);
	this.sendMsg(message, priority);
    }

    // EEE functions (switch on/off display values)
    // FIXME: the following shown functions need addressCache to be created before calling them
    isVoltageShown()
    {
	logger.debug("isVoltageShown");
	get("0xEEE0");
    }

    setStateOfCharge(soc)
    {
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
        this.get("0x0FFF");
    }

    setBatteryCapacity(capacity) {
        logger.debug("setBatteryCapacity to " + capacity);

        let strCapacity = toEndianHexStr(capacity, 2);
        this.set("0x1000", strCapacity);
    };

    getBatteryCapacity()
    {
	logger.debug("getBatteryCapacity");
	this.get("0x1000");
    }

    setChargedVoltage(voltage)
    {
        logger.debug("setChargedVoltage to " + voltage);
        let strVoltage = toEndianHexStr(voltage, 2);
        this.set("0x1001", strVoltage);
    }

    getChargedVoltage()
    {
	logger.debug("getChargedVoltage");
	this.get("0x1001");
    }

    setTailCurrent(current)
    {
        logger.debug("setTailCurrent to " + current);
        let strCurrent = toEndianHexStr(current, 2);
        this.set("0x1002", strCurrent);
    }

    getTailCurrent()
    {
	logger.debug("getTailCurrent");
	this.get("0x1002");
    }

    setChargedDetectTime(time)
    {
        logger.debug("setChargedDetectTime to " + time);
        let strTime = toEndianHexStr(time, 2);
        this.set("0x1003", strTime);
    }

    getChargedDetectTime()
    {
	logger.debug("getChargedDetectTime");
	this.get("0x1003");
    }


    setChargeEfficiency(percent)
    {
        logger.debug("setChargeEfficiency to " + percent);
        let strPerc = toEndianHexStr(percent, 2);
        this.set("0x1004", strPerc);
    }

    getChargeEfficiency()
    {
	logger.debug("getChargeEfficiency");
	this.get("0x1004");
    }

    setPeukertCoefficient(coeff)
    {
        logger.debug("setPeukertCoefficient to " + coeff);
        let strCoeff = toEndianHexStr(coeff, 2);
        this.set("0x1005", strCoeff);
    }

    getPeukertCoefficient()
    {
	logger.debug("getPeukertCoefficient");
	this.get("0x1005");
    }

    setCurrentThreshold(current)
    {
        logger.debug("setCurrentThreshold to " + current);
        let strCurrent = toEndianHexStr(current, 2);
        this.set("0x1006", strCurrent);
    }

    getCurrentThreshold()
    {
	logger.debug("getCurrentThreshold");
	this.get("0x1006");
    }

    setTimeToGoDelta(time)
    {
        logger.debug("setTimeToGoDelta to " + time);
        let strTime = toEndianHexStr(time, 2);
        this.set("0x1007", strTime);
    }

    getTimeToGoDelta()
    {
	logger.debug("getTimeToGoDelta");
	this.get("0x1007");
    }

    isTimeToGoShown()
    {
	logger.debug("isTimeToGoShown");
	this.get("0xEEE6");
    }

    setShowTimeToGo(onOff)
    {
	logger.debug("setShowTimeToGo to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE6", strOnOff);
    }

    isTemperatureShown() {
	logger.debug("isTemperatureShown");
	this.get("0xEEE7");
    }

    setShowTemperature(onOff)
    {
	logger.debug("setShowTemperature to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE7", strOnOff);
    }

    isPowerShown()
    {
	logger.debug("isPowerShown");
	this.get("0xEEE8");
    }

    setShowPower(onOff)
    {
	logger.debug("setShowPower to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE8", strOnOff);
    }

    setRelayLowSOC(percent)
    {
        logger.debug("setRelayLowSOC to " + percent);
        let strPercent = toEndianHexStr(percent, 2);
        this.set("0x1008", strPercent);
    }

    getRelayLowSOC()
    {
	logger.debug("getRelayLowSOC");
	this.get("0x1008");
    }

    setRelayLowSOCClear(percent)
    {
        logger.debug("setRelayLowSOCClear to " + percent);
        let strPercent = toEndianHexStr(percent, 2);
        this.set("0x1009", strPercent);
    }

    getRelayLowSOCClear()
    {
	logger.debug("getRelayLowSOCClear");
	this.get("0x1009");
    }

    setUserCurrentZero(count)
    {
        logger.debug("setUserCurrentZero to " + count);
        let strCount = toEndianHexStr(count, 2);
        this.set("0x1034", strCount);
    }

    getUserCurrentZero()
    {
	logger.debug("getUserCurrentZero");
	get("0x1034");
    }

    setShowVoltage(onOff)
    {
        logger.debug("setShowVoltage to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE0", strOnOff);
    }

    isAuxiliaryVoltageShown()
    {
	logger.debug("isAuxiliaryVoltageShown");
	get("0xEEE1");
    }
    
    setShowAuxiliaryVoltage(onOff)
    {
        logger.debug("setShowAuxiliaryVoltage to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE1", strOnOff);
    }

    setShowMidVoltage(onOff)
    {
        logger.debug("setShowMidVoltage to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE2", strOnOff);
    }

    isCurrentShown()
    {
	logger.debug("isCurrentShown");
	this.get("0xEEE3");
    }

    isMidVoltageShown()
    {
	logger.debug("isMidVoltageShown");
	this.get("0xEEE2");
    }

    setShowCurrent(onOff)
    {
        logger.debug("setShowCurrent to " + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set("0xEEE3", strOnOff);
    }

    setShowConsumedAh(onOff)
    {
	logger.debug("setShowConsumedAh to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE4", strOnOff);
    }

    isConsumedAhShown()
    {
	logger.debug("isConsumedAhShown");
	this.get("0xEEE4");
    }

    setShowStateOfCharge(onOff)
    {
	logger.debug("setShowStateOfCharge to " + onOff);
	let strOnOff = toEndianHexStr(onOff, 1);
	this.set("0xEEE5", strOnOff);
    }

    isStateOfChargeShown()
    {
	logger.debug("isStateOfChargeShown");
	this.get("0xEEE5");
    }

    writeDeviceConfig(newCurrent, oldCurrent, precision, timestamp)
    {
	logger.trace("writeDeviceConfig");
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
	logger.debug("Writing config to file");
	let file = __dirname + '/config.json';
	// check: exist and writable
	fs.access(file, fs.constants.F_OK | fs.constants.W_OK, (err) =>
		  {
                      if (err) {
			  logger.error(
                              `cannot write ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is read-only'})`);
                      } else {
			  fs.writeFile(file, jsonConfig, (err) => {
                              if (err) logger.error(err)
                              else logger.info(file + " saved!");
			  });
			  //let config_file = fs.createWriteStream(__dirname + '/config.json', {flags: 'w'});
			  //config_file.write(jsonConfig);
                      }
		  });
	console.log("deleting relayLowSOCClear listener");
	this.registerListener('relayLowSOCClear', null);
    }

    getDeviceConfig(doSave)
    {
        logger.trace("getDeviceConfig");
        this.getBatteryCapacity();
        this.getChargedVoltage();
        this.getTailCurrent();
        this.getChargedDetectTime();
        this.getChargeEfficiency();
        this.getPeukertCoefficient();
        this.getCurrentThreshold();
        this.getTimeToGoDelta();
        this.getRelayLowSOC();

        if (doSave) {
            // prepare for saving the data:
            console.log("registering writeDeviceConfig listener for relayLowSOCClear");
            this.registerListener('relayLowSOCClear', this.writeDeviceConfig);
            this.getRelayLowSOCClear();
        }
    }

    set_relay_mode(mode) {
	logger.debug("set relay mode");
	this.port.write(':84F030002F9'); // mode = 2 (rmt)
    }

    setRelay(mode) {
        logger.debug("set relay");
        this.set_relay_mode();
        if (mode === 0)
            this.set("0x034E", "00", 1);
        else
            this.set("0x034E", "01", 1);
    }

    set_alarm() {
        logger.debug("set alarm");
        this.set("0xEEFC", "01");
    }
    
    clear_alarm() {
        logger.debug("clear alarm");
        //this.set("0xEEFC", "00");
        this.set("0x031F", "00");
    }

    ping() {
        logger.debug("ping");
        //port.write(':154\n'); // ping
        this.sendSimpleCommand('1', '5');
        // returns :5 05 43 08 ==> 0x4305 ==> version 3.05
        // 5 = reply to ping
        // CS 0x55
    };

    app_version() {
        logger.debug("app version");
        //port.write(':352\n'); // application version
        this.sendSimpleCommand('3', '1');
        // returns :1 05 43 0C ==> 0x4305 ==> version 3.05
        // 1 = Done
        // CS 0x55
    }

    productId() {
	logger.debug("product id");
	this.sendSimpleCommand('4', '1');
	//port.write(':451\n'); // product ID
	// returns :1 04 02 4E ==> 0x0204 ==> version 0x204 ==> BMV 702
	// 1 = Done
	// CS 0x55
    }
    
    registerListener(bmvdataKey, listener)
    {
	if (bmvdataKey === "Checksum") this.on = listener;
        else bmvdata[bmvdataKey].on = listener;
    }
    
    hasListener(bmvdataKey)
    {
	if (bmvdataKey === "Checksum") return this.on !== null;
        else return bmvdata[bmvdataKey].on !== null;
    }

    update() {
        return bmvdata;
    }

    close() {
        console.log("closing port");
        port.close();
    }
}

// ES6:
// const instance = new VitronEnergyDevice();
// export default instance;
module.exports.VitronEnergyDevice = new VitronEnergyDevice();
Object.freeze(exports.VitronEnergyDevice);

//
// BMV
//

//'use strict';

// TODO:
// - cope with unplugged cable:
//    events.js:183
//      throw er; // Unhandled 'error' event
//      ^
//
//    Error: Error: No such file or directory, cannot open /dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE1SUT80-if00-port0
// - use soc closest to zero current of last x min
// - introduce optional read from cache
// - first parse: parse until checksum ok then create objects from it for cache - only then do the up/download of config
// - further parse: replace callback function by final parse function to do updates
// - register function has switch statement to create each object after each other (only those appearing in update packet)
// - response from BMV to set command: also compare returned value
// - ensure setTimeout within class works

// FIXES needed:
// - message times out and is removed from responseMap but then
//        may still arrive (not being found in repsonseMap -> TODO: timeoutmap???
// - read relay mode at startup and check cache in later stages whether it needs to be set
// - debug.log is written into . and /var/log/.

const Math = require('mathjs');
var fs = require('fs');
//var util = require('util');
//var log_file = fs.createWriteStream(__dirname + '/debug.log', {flags: 'w'});
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
    default: { appenders: ['everything'], level: 'debug' }
  }
});



const logger = log4js.getLogger();
logger.level = 'debug';

var date = new Date();
logger.debug('Service started at ' +
             date.toLocaleString('en-GB', { timeZone: 'UTC' }));

// Data model:
//
// Each value (volt, current, power, state of charge...) owns a register
// on the device. All registers are cached in objects of this application.
// These objects also provide conversions, formatters, units, callbacks
// on change, descriptions etc.
// The BMV sends some of these register values in two packages every
// 1 second (1-second-updates). The history package contains
// (H1, H2, ...) and the second package the actual values like voltage,
// current, power, state of charge.
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

// \return str trimming off anything beyond \n incl. if exists
function trimLF(str) {
    return str.split('\n')[0];
}


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
        let res = line.split('\t');

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
        if (res[0] === 'Checksum')
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
};



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
        logger.warn('endianSwap() not implemented for 12 bytes');
    return hexStr.toUpperCase();
}



// \pre cmd must be a command without the checksum and start
//      hexadecimal (without ':').
function append_checksum(cmd) {
    logger.trace('append_checksumNew');
    const command = '0' + cmd;

    const byteInHex = command.split('').map(c => parseInt(c, 16));
    let checksum = byteInHex.reduce((total, hex, index) =>
                    (index % 2 === 0 ? total + hex * 16 : total + hex), 0);
    checksum = (0x55 - checksum) % 256;
    if (checksum < 0) checksum += 256;
    return cmd + ('0' + checksum.toString(16)).slice(-2).toUpperCase();
}


var sendMessageDeferTimer = null;


//setTimeout(function() 
//    {
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
//    } , 10100);

////////////////////////////////////////////////////////////////////////////////////////
//
// Getting a value takes in average 4 seconds while many values update the device cache
// every 1 second. Hence it does not make sense to get values that are sent by the
// device's regular updates.
//

// getUpperVoltage is better retrieved from the deviceCache via map['V'].
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
    let str = '0';
    if (value != null && value != undefined) str = value.toString(16); // hexadecimal
    str = endianSwap(str, lengthInBytes);
    return str;
}





// var readline = require('readline');

// var myInterface = readline.createInterface({
//   input: fs.createReadStream('serial-test-data', {encoding: 'binary'})
// });

// myInterface.on('line', function (line) {
//     map_components();
//     parseSerialInput(line);
// });


// Commands:
const pingCommand = '1';
const versionCommand = '3';
const productIdCommand = '4';
const restartCommand = '6';
const getCommand = '7';
const setCommand = '8';
// 2020-05-06: async commands not working: reply is 30A00
const asyncSetCommand = 'A'; // same as setCommand without response

// Responses:
const pingResponse = '5';
const doneResponse = '1';
const unknownResponse = '3';

// Message states:
const isOK = 0;
const isUnknownID = 1;
const isNotSupported = 2;
const isParameterError = 4;



class Message {

    constructor() {
        logger.trace('Message::constructor()');
        this.cmdStr  = null; // raw cmd string w/o frame i.e. without : and trailing \n
        this.command = null; // the Vitron command: 1, 3, 4, 6, 7, 8 or A
        this.address = null; // 2 byte, as string in hex format
        this.state   = null; // 1 byte, as string in hex format
        this.value   = null; // 1-4 byte, as string in hex format
        this.id      = null; // concatenation of command and endianSwapped(address)
    }

    // \param cmdStr the command without the leading : and trailing \n, i.e. caaaammv..vvss
    //        with c=command, aaaa=address (4 hex), mm=message state (2 hex), v...vv=value
    //        ss=checksum
    // \return identifier
    parseIdentifier(cmdStr) {
        logger.trace('Message::parseIdentifier(' + cmdStr + ')');
        const c = this.parseCommand(cmdStr);
        if (c !== getCommand && c !== setCommand)
            return c; // for commands without an register address
        return cmdStr.substring(0, 5);
    }

    // \return command
    parseCommand(cmdStr) { return cmdStr.charAt(0); }

    // \return address
    parseAddress(cmdStr) {
        logger.trace('Message::parseAddress(' + cmdStr + ')');
        const c = this.parseCommand(cmdStr);
        if (c !== getCommand && c !== setCommand)
            return null; // for commands without an register address
        const address = cmdStr.substring(1, 5);
        return endianSwap(address, address.length / 2); // 2 bytes
    }

    // \return message state
    parseState(cmdStr) {
        logger.trace('Message::parseState(' + cmdStr + ')');
        const c = this.parseCommand(cmdStr);
        if (c !== getCommand && c !== setCommand)
            return null; // for commands without an register address
        const state = parseInt(cmdStr.substring(5, 7));
        const id = this.getId();
        const value = this.getValue();
        switch (state) {
        default:
        case isOK:
            break;
        case isUnknownID:
            logger.error('Specific Id ' + id + ' does not exist');
            break;
        case isNotSupported:
            logger.error('Attempting to write to a read only value at ' + id);
            break;
        case isParameterError:
            logger.error('The new value ' + value + ' of ' +
                         id + ' is out of range or inconsistent');
            break;
        }
        return state;
    }

    // FIXME: implement parseValue in Response and Command where response usually has a value
    //        but command only for setCommand...
    // \return value swapped, converted to hex ready for use
    parseValue(cmdStr) {
        logger.trace('Message::parseValue(' + cmdStr + ')');
        let value = null;
        const c = this.parseCommand(cmdStr);
        if (c !== getCommand && c !== setCommand)
            value = cmdStr.substring(1, cmdStr.length - 2);
        else value = cmdStr.substring(7, cmdStr.length - 2);
        let noOfBytes = Math.floor(value.length / 2);
        value = endianSwap(value, noOfBytes);
        logger.debug('endianed hex value: ' + value);
        return value;
    }

    // \param cmdStr has the format caaaammv..vss without frame (: and \n)
    //        where c is out of {1, 3, 4, 6, 7, 8}, aaaa is a 2-byte address,
    //        mm is the 1-byte message status, v...v is a multi-byte value and
    //        ss is the 1-byte checksum
    parse(cmdStr) {
        // the standard parser splits line by '\r\n'
        // while a command response ends with '\n' only.
        // I.e. there may be a chunk of stuff after the \n
        // that needs to be split away.
        logger.trace('Message::parse(' + cmdStr + ')');

        this.command = this.parseCommand(cmdStr);
        this.address = this.parseAddress(cmdStr);
        this.state   = this.parseState(cmdStr);
        this.value   = this.parseValue(cmdStr);
        this.id      = this.parseIdentifier(cmdStr);
    }

    getCommand() {
        if (this.command === null)
            this.command = this.parseCommand(this.cmdStr);
        return this.command;
    }

    setCommand(cmd) {
        this.command = cmd;
    }

    getAddress() {
        if (this.address === null)
            this.address = this.parseAddress(this.cmdStr);
        return this.address;
    }

    getState() {
        if (this.state === null)
            this.state = this.parseState(this.cmdStr);
        return this.state;
    }

    getValue() {
        if (this.value === null)
            this.value = this.parseValue(this.cmdStr);
        return this.value;
    }

    getId() {
        if (this.id === null)
            this.id = this.parseIdentifier(this.cmdStr);
        return this.id;
    }

    getMessage() {
        return this.cmdStr;
    }
};


class Response extends Message {

    // \brief  Constructs a response from a string or from a class Command object
    // \detail If cmd is of type class Command then an expected response for this
    //         command is created, i.e. for a pingCommand ('1') a pingResponse is
    //         created.
    // \param  cmd is either a response string coming in as a message from the serial port
    //         or of class Command
    constructor(cmd) {
        super();
        logger.trace('Response::constructor(' + cmd + ')');
        this.cmdStr = trimLF(cmd);
        this.parse(this.cmdStr);
    }

    toString() {
        let r = 'id: ' + this.getId();
        switch (this.getCommand()) {
        case doneResponse: // FIXME: doneResponse is returned for versionCommand and productIdCommand!!!
            r = '- version() => ' + this.getValue();
            break;
        case pingResponse:
            r = '- ping() => ' + this.getValue();
            break;
        case getCommand:
            r = '- get(' + this.getAddress() + ') => (' +
                this.getValue() + ', ' + this.getState() + ')';
            break;
        case setCommand:
            r = '- set(' + this.getAddress() + ', ' + this.getValue() + ') => (' +
                this.getValue() + ', ' + this.getState() + ')';
            break;
        }
        return r;
    }

    getChecksum(cmd) { return cmd.substring(cmd.length - 2); }

    // \return true if Response's command is cmd
    is(cmd) { return (this.getCommand() === cmd); }

    // \return true if the response message was submitted correctly
    isValid(cmd) {
        logger.trace('Response::isValid(' + cmd + ')');
        if (cmd.length < 3) return false;
        const rcs = append_checksum(cmd.substring(0, cmd.length - 2));
        const expectedCS = this.getChecksum(rcs);
        const actualCS = this.getChecksum(cmd);
        if (actualCS !== expectedCS)
        {
            logger.error('command checksum: ' + actualCS +
                         ' - expected: ' + expectedCS);
            return false;
        }
        return true;
    }


    // \param cmdStr has the format caaaammv..vss\n
    //        where c is out of {1, 3, 4, 6, 7, 8}, aaaa is a 2-byte address,
    //        mm is the 1-byte message status, v...v is a multi-byte value and
    //        ss is the 1-byte checksum
    parse(cmdStr) {
        // the standard parser splits line by '\r\n'
        // while a command response ends with '\n' only.
        // I.e. there may be a chunk of stuff after the \n
        // that needs to be split away.
        // remove trailing \n (carriage return):

        logger.trace('Response::parse(' + cmdStr + ')');

        if (!this.isValid(cmdStr)) return;

        super.parse(cmdStr);
    }
};


var cmdDefaultPriority   = 0;
var cmdDefaultMaxRetries = 3;
var cmdCompression    = true;

class Command extends Message {

    // \param address is a string of the form 0xzzzz in hexadecimal format
    //        with 2 byte
    // \param priority is 0 or 1, 1 is prefered execution,
    //        if no priority is given 0 is assumed
    constructor(cmd, address, value, priority, maxRetries) {
        super();
        logger.trace('Command::constructor(' + cmd + ', ' +
                     address + ', ' + value +
                     ', ' + priority + ', ' + maxRetries + ')');
        this.setPriority(priority);
        this.setMaxRetries(maxRetries);
        this.cmdStr = this.createMessage(cmd, address, value);
        super.parse(this.cmdStr);
    }

    toString() {
        let r = 'id: ' + this.getId();
        switch (this.getCommand()) {
        case versionCommand:
            r = '- version()';
            break;
        case pingCommand:
            r = '- ping()';
            break;
        case getCommand:
            r = '- get(' + this.getAddress() + ') => (' + this.getValue() + ', ' + this.getState() + ')';
            break;
        case setCommand:
            r = '- set(' + this.getAddress() + ', ' + this.getValue() + ') => (' +
                this.getValue() + ', ' + this.getState() + ')';
            break;
        }
        return r;
    }

    // \return the response string that can be expected after sending command
    getResponse() {
        logger.trace('Command::getResponse()');
        // create a response from the command
        let r = this.getCommand(); // initialize response
        const cmdStr = this.getMessage();
        let len = 1; // initial length of response message
        switch (r) {
        case pingCommand:
            r = pingResponse;
            break;
        case versionCommand:
        case productIdCommand:
            r = doneResponse;
            break;
        case getCommand:
            len = cmdStr.length - 2;
            break;
        case setCommand:
            len = cmdStr.length;
            break;
        default: // restartCommand, asyncSetCommand should never get here
            // do nothing
            logger.warn('No response for ' + r);
            break;
        }
        r = r + cmdStr.substring(1, len);
        logger.debug('Created response for command class :' + this.getMessage() + '\\n: ' + r);
        return r;
    }

    getPriority() {
        return this.priority;
    }

    // \param p in [0; 1], 1 is higher priority
    setPriority(p) {
        if (p) this.priority = p;
        else this.priority = cmdDefaultPriority;
        this.priority = Math.min(1, this.priority);
        this.priority = Math.max(0, this.priority);
    }

    // \param mr >= 0
    setMaxRetries(mr) {
        if (mr) this.maxRetries = mr;
        else this.maxRetries = cmdDefaultMaxRetries;
        this.maxRetries = Math.max(0, this.maxRetries);
    }

    // \param cmd is out of {pingCommand, versionCommand, getCommand, setCommand, asyncSetCommand}
    // \note 2020-05-06: async commands not working with my version of BMV FW: reply is 30A00
    // \param address is a string and has the format 0x.... (uint16 with leading zeros if needed)
    // \param value as string, little endianed and filled with 0 from the left
    // \return a message of the format caaaammv..vss\n
    //        where c is out of {1, 3, 4, 6, 7, 8}, aaaa is a 2-byte address,
    //        mm is the 1-byte message status, v...v is a multi-byte value and
    //        ss is the 1-byte checksum
    createMessage(cmd, address, value) {
        logger.trace('Command::createMessage');
        let flag = '';
        let eAddress = ''; // endian swapped address
        logger.debug('===================================');
        logger.debug('cmd:          ' + cmd);
        if (address.length > 2) { // only get/set have and address and a flag
            // remove 0x
            address = address.substring(2);
            eAddress = endianSwap(address, 2);
            logger.debug('address:      0x' + address + ' (' + eAddress + ')');
            flag = '00';
        }
        if (value.length > 0) {
            logger.debug('value:        0x' + value);
        }
        //FIXME: value needs to be endian "swapped"
        //let command = ':' + cmd + eAddress + this.state + value;
        // the state (flag) of a command is always 00 for outgoing messages
        let command = cmd + eAddress + flag + value;
        command = append_checksum(command).toUpperCase();
        logger.debug('message:      ' + command);
        return command;
    }
};


// \class CommandMessageQ is a queue of messages that contain commands
// \brief A message is composed of the command and its parameters
// \detail The messages are in the Q as final messages as to be send to
//        the device, i.e. with the leading colon and trailing \n.
class CommandMessageQ {

    constructor() {
        logger.trace('CommandMessageQ::constructor');
        this.cmdMessageQ = [];
        // two subsequent messages with the same command (and possible different
        // parameters) are "compressed" into one command with the parameters of
        // the second message
        // e.g. set relay on, off, on, off, on, off mostly does not make
        // sense so it is enough to send the last command "off"
        this.cmdCompression = cmdCompression;
    }

    // \param value is either true or false
    setCmdCompression(value)
    {
        logger.trace('CommandMessageQ::setCmdCompression');
        this.cmdCompression = value;
    }

    // \brief  delete element indexNo in the Q
    // \return the cmdMessageQ[indexNo]
    del(indexNo) {
        let lastCmd;
        if (indexNo >= 0 && indexNo < this.cmdMessageQ.length) {
            lastCmd = (this.cmdMessageQ.splice(indexNo, 1))[0]; // finished work on this message - dump
            logger.debug(':' + lastCmd.getMessage() + '\\n processed - dequeing');
        }
        logger.debug('Cmd Q: ' + this.cmdMessageQ.length);
        return lastCmd;
    }

    find(responseId) {
        let cmdQIndex;
        for (cmdQIndex = 0; cmdQIndex < this.cmdMessageQ.length; ++cmdQIndex)
        {
            if (responseId === this.cmdMessageQ[cmdQIndex].getId())
            {
                break; // jump out of the loop without increasing i
            }
        }
        if (cmdQIndex === this.cmdMessageQ.length)
        {
            logger.error('response ' + responseId +
                         ' does not map any queued command: ');
            if (this.cmdMessageQ.length === 0)
                logger.error('MessageQ empty');
            else {
                logger.error('MessageQ is:');
                this.cmdMessageQ.map(c => logger.error(c.getMessage()));
            }
        }
        return cmdQIndex;
    }

    // FIXME: find and delete should be part of the array stuff

    // \brief finds id in this.cmdMessageQ and deletes it
    // \param id as returned by Message::getId()
    // \return -1 means the id does not match any queued command
    //        0 response is OK
    delete(id) {
        let retval = isOK;
        const cmdQIndex = this.find(id);
        if (cmdQIndex === this.getQLength())
        {
            retval = isUnknownID;
        }
        else this.del(cmdQIndex);
        return retval;
    }

    // \pre    the priorities in cmdMessageQ must be descending
    // \return the next index of the element that has at least priority
    //         the returned index is guaranteed in [0; this.cmdMessageQ.length]
    indexForPriority(priority) {
        let i = this.cmdMessageQ.length;
        // start the search from the end of cmdMessageQ
        while (--i > 0 && this.cmdMessageQ[i].getPriority() < priority);
        return i + 1;
    }


    // \detail scroll through all array elements with priority 1 from the start of the
    //         array. Insert message after last message with priority 1
    insertPriority(message, indexOfInsertion) {
        let i = 0;
        let prioOneMsg = [];
        for (i = 0; i < indexOfInsertion; ++i)
        {
            prioOneMsg.push(this.cmdMessageQ.shift());
        }
        // assert(this.cmdMessageQ[i] === 0 or i >= this.cmdMessageQ.length)
        prioOneMsg.push(message);
        this.cmdMessageQ = prioOneMsg.concat(this.cmdMessageQ);
    }

    // \details a message is generally appended to the end of the Q.
    //          If the message contains the same command as the last
    //          in the Q (possibly with different params) and
    //          cmdCompression is on, then the last message in the Q
    //          is replaced by the incoming message. This is not done
    //          if the last message is the only and first message in
    //          the Q because the first message is already send and
    //          executed.
    // \param command of class Command
    Q_push_back(cmd) {
        logger.trace('CommandMessageQ::Q_push_back');
        //const l = this.cmdMessageQ.length;
        const l = this.indexForPriority(cmd.getPriority()); // in [0; this.cmdMessageQ.length]

        if (l < this.cmdMessageQ.length) logger.debug('Prioritizing ' + cmd.toString());
        logger.debug('Inserting at index ' + l + ' of ' + this.cmdMessageQ.length);
        // check: current command is same as previous but with possibly different
        //        parameter ==> if cmdCompression, execute only current command and
        //        skip previous
        if (this.cmdCompression &&
            // l > 1: must not touch command at pos 0 because it is executed
            l > 1 && (this.cmdMessageQ[l - 1].getId() == cmd.getId()))
        {   // replace last command with possibly different params
            this.cmdMessageQ[l - 1] = cmd;
            logger.debug('Command compression: previous command ' +
                         (l - 1) + ' in Q replaced: ' + this.cmdMessageQ.length);
        }
        else
        {
            // never execute the very same command with same parameters
            // twice as it is like bouncing
            if (l === 0 || this.cmdMessageQ[l - 1].getMessage() != cmd.getMessage())
            {
                this.insertPriority(cmd, l);
                logger.debug('Cmd Q: ' + this.cmdMessageQ.length);
            }
            else
            {
                logger.debug('Repeated message ignored: ' + cmd.getMessage());
            }
        }
        //logger.debug("MessageQ is:");
        //this.cmdMessageQ.map(c => logger.error(trimLF(c.getMessage())));
    }

    isEmpty() {
        return (this.cmdMessageQ.length === 0);
    }

    getQLength() {
        return this.cmdMessageQ.length;
    }
};


var cmdResponseTimeoutMS = 6000;
var serialportFile       = "/dev/serial/by-id/usb-VictronEnergy_BV_VE_Direct_cable_VE1SUT80-if00-port0";
var doRecord             = false;
var recordFile           = "serial-test-data.log";
var isConfigured         = false;

var readAppConfig = function()
{
    const file = __dirname + '/app-config.json';
    fs.readFile(file, 'utf8', (err, data) => {
        if (err) {
            logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        } else {
            console.log("Parse configuration (JSON format)");
            let config = JSON.parse(data);
            cmdDefaultPriority   = config.Commands.defaultPriority;
            cmdDefaultMaxRetries = config.Commands.defaultMaxRetries;
            cmdCompression       = config.Commands.compression;
            cmdResponseTimeoutMS = config.Commands.responseTimeoutInMS;

            serialportFile       = config.Device.serialportFile;
            doRecord             = config.Device.doRecord;
            recordFile           = config.Device.recordFile;
        }
	isConfigured = true;
    });
}

readAppConfig();


class ReceiverTransmitter {
    constructor() {
        this.isOperational = false;
        this.sendMessageDeferTimer = null;
        this.deferalTimeInMs = 1000;
        // measured max response time approx. 3984ms
        this.cmdResponseTimeoutMS = cmdResponseTimeoutMS; // milliseconds
        this.checksum = new RegularUpdateChecksum();
        this.responseMap = {};
        this.cmdQ = new CommandMessageQ();
        this.port = null;
        this.open(serialportFile);
        this.maxResponseTime = 0;
        this.isRecording = doRecord;
        if (this.isRecording)
            this.recordFile = fs.createWriteStream(__dirname + '/' + recordFile, {flags: 'w'});
        else this.recordFile = null;
        this.on = [];
        this.packageArrivalTime = 0;
    }

    updateCacheObject(key, obj) {
        let changeObj = null;
        //  value received by serial parser ==> newValue != null
        if (obj.newValue != null && obj.value !== obj.newValue)
        {
            //console.log("updating " + key + " " + obj.value + " => " + obj.newValue);
            let oldValue = obj.value;
            obj.value = obj.newValue; // accept new values
            // send event to listeners with values
            // on() means if update applied,

            if (obj.on.length > 0
                && Math.abs(oldValue - obj.newValue) * obj.nativeToUnitFactor >= obj.delta)
            {
                changeObj = obj;
		for (let i = 0; i < obj.on.length; ++i)
		    obj.on[i](obj.newValue, oldValue, this.packageArrivalTime, key);
            }
        }
        obj.newValue = null;
        return changeObj;
    }

    updateValuesAndValueListeners() {
        logger.trace('ReceiverTransmitter::updateValuesAndValueListeners');
        let changedObjects = [];
	// FIXME: Object.entries(map)
        for (const[key, obj] of Object.entries(bmvdata)) {
            changedObjects.push(this.updateCacheObject(key, obj));
        }
        if (this.on.length > 0)
	    for (let i = 0; i < this.on.length; ++i)
		this.on[i](changeObjects, this.packageArrivalTime);
    }

    discardValues() {
        logger.trace('ReceiverTransmitter::discardValues');
        // FIXME: should only discard values that are coming from regular updates
        for (const [key, obj] of Object.entries(map)) {
            obj.newValue = null; // dump new values
        } 
    }

    // \brief Set or remove a listener for the list of changes 
    // \details Set null to remove the listener.
    // \note the same listener is allowed to appear several times in the array
    //       whether it makes sense or not.
    registerListener(listener)
    {
        logger.trace('ReceiverTransmitter::registerListener');
        this.on.push(listener);
    }

    findListenerIndex(listener) {
	for (let i = 0; i < this.on.length; ++i)
	{
	    if (this.on[i] === listener) return i;
	}
    }

    deregisterListener(listener)
    {
        logger.trace('ReceiverTransmitter::deregisterListener');
	let i = findListenerIndex(listener);
	delete this.on[i];
    }

    evaluate(response) {
        const id = response.getId();

        // An inValid response has a wrong CRC. Any part of the message can
        // be corrupt. Hence the address may not be correct and it has to be
        // ignored. The timeout mechanism will kick in to repeat this message.
        if ( ! response.isValid(response.getMessage()) ) {
            // in this case response.getId() may not be corrupt and not be in responseMap
            logger.debug('Invalid response - CRC error - repeating message');
            // leave message in Q and run Q again to repeat the command that failed
        } 
        else if (id in this.responseMap)
        {
            clearTimeout(this.responseMap[id].timerId)
            logger.debug(id + ' in responseMap ==> clear timeout');
            // logger.errors are for finding conv.hexToInt issue (to be removed)
            if (this.responseMap[id].expect
                !== response.getMessage().substring(0, this.responseMap[id].expect.length)) {
                logger.error('Device refused to set expected value');
            }
            else { // process response and remove it from Q and responseMap
                switch (this.responseMap[id].func(response)) {
                default: // getState is called and already prints the error if state is not OK
                    break;
                case isUnknownID:
                    logger.error('Address 0x' + responseMap[id].orgCmdId.substring(1) + ' unknown');
                }
            }
            this.runMessageQ();
        }
        else if (id === '40000') // reply after restart
        {
            logger.debug('restart successful');
        }
        // FIXME: if framing error or unkownResponse happens several times
        //        we may consider to remove the first command from the Q as this may cause
        //        the issue
        // in all the following cases the command that causes the issue is not know
        // ==> nothing to delete out of the Q or responseMap
        else if (id.charAt(0) === unknownResponse)
        {
            // FIXME: test with asyncCommand!
            logger.debug('unkown command ' + id.substring(1));
        }
        // BMV-7xx HEX Protocol describes that the device returns "AAAA" in case
        // of a framing error, however, experiments showed that the response
        // to a framing error looks like "2AAAA". The following implementation
        // caters both cases:
        else if (id.substring(0, 4) === 'AAAA' || id === '2AAAA')
        {
            logger.error('framing error');
        }
        else
        {
            // FIXME: was response.id - does this now print the entire object? test!
            logger.warn('unwarrented command ' + response.toString() + ' received - ignored');
        }
        // TODO: check regularly for left overs in responseMap and cmdMessageQ
    }

    open(ve_port) {
        logger.trace('ReceiverTransmitter::open(.)');
	// FIXME: 
	// if (! isConfigured ) ...
        this.port =  new serialport(ve_port, {
            baudrate: 19200,
            parser: serialport.parsers.readline('\r\n', 'binary')});
        this.port.on('data', function(line) {
            this.isOperational = true;
            if (this.isRecording)
            {
                this.recordFile.write(line + '\r\n');
            }
            this.parseSerialInput(line);
        }.bind(this));
    }

    close() {
        logger.trace('ReceiverTransmitter::close');
        logger.debug('Max. command response time: ' + this.maxResponseTime + ' ms');
        this.port.close();
    }

    parseSerialInput(line) {
        logger.trace('ReceiverTransmitter::parseSerialInput');
        // a line contains a key value pair separated by tab:
        let res = line.split('\t');
        // res[0] is the key, res[1] the value
        if (!res[0] || res[0] === '')
        {
            if (res[1] && res[1].length > 1 && res[1].substring(1).split(':'))
            {
                logger.warn('Content found after tab without key');
            }
            return; // empty string
        }

        const checksumKey = 'Checksum';
        if (res[0] === checksumKey)
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
            let expectedCS = (256 - (this.checksum.get() % 256) + 196) % 256; // Checksum+\t
            if (expectedCS < 0) { expectedCS = expectedCS + 256; }

            // line may contain garbage after the checksum, therefore
            // restrict the line to the checksumKey plus tab plus the checksum value
            let cs = this.checksum.update(line.substring(0, checksumKey.length + 2));
            cs = cs % 256;
            if (cs === 0) // valid checksum for periodic frames
            {
                //console.log("updateValuesAndValueListeners");
                this.updateValuesAndValueListeners(false);
            }
            else // checksum invalid
            {
                this.discardValues();
                const expStr = ' - expected: 0x' + expectedCS.toString(16)
                      + ' (' + expectedCS + ')';
                const prefix = 'data set checksum: ';
                if (res[1].length === 0)
                {
                    logger.error(prefix + 'checksum missing' + expStr);
                }
                else // in case a response arrived, checksum is mostly invalid => no error
                {
                    const isStr = '0x' + res[1].charCodeAt(0).toString(16) + ' ('
                          + res[1].charCodeAt(0)
                          + ')';
                    logger.warn(prefix + isStr + expStr);
                }
            }
            this.packageArrivalTime = 0;
            this.checksum.reset(); // checksum field read => reset checksum
            // frame always finishes before another frame
            // or before a command response arrives.
            // Check for command response now:

            // res[1] contain the checksum of the previous frequent update package,
            // and at least the : and the command
            if (res[1].length <= 3) return;
            // checksum value is followed by optional garbage and
            // optional command responses all in res[1].
            // First char of res[1] contains checksum value so start from 1:
            // None, one or several command responses can follow a frame.
            // Command responses always start with : and end with \n.
            var cmdSplit = res[1].substring(1).split(':');
            // split "swallows" the colon : so each element cmdSplit
            // has the format caaaammv...vss\n.
            var cmdIndex;
            for (cmdIndex = 1; cmdIndex < cmdSplit.length; ++cmdIndex) {
                const line = trimLF(cmdSplit[cmdIndex]);
                logger.debug('Creating response for ' + line);
                const r = new Response(line);
                this.evaluate(r);
            }
        }
        else
        {
            if (res[0] === undefined) return;
            // a line consist of:
            // field name + tab + field value + return
            // the "return is consumed outside parseSerialInput by the readline command
            // the "tab" is consumed by the split command at the top of this function
            this.checksum.update(line);
            if (this.packageArrivalTime === 0) this.packageArrivalTime = Date.now();
            if (res[0] in map && map[res[0]] !== undefined) map[res[0]].newValue = res[1];
            else logger.warn('parseSerialInput: ' + res[0]
                             + ' is not registered and has value ' + res[1]);
        }
    };

    // \detail starts or continues working the commands in the message Q
    //         if serial port is operational and Q is not empty.
    runMessageQ()
    {
        logger.trace('ReceiverTransmitter::runMessageQ');
        if (this.cmdQ.isEmpty()) {
            logger.debug('MessageQ empty');
            return;
        }
        if (this.isOperational)
        {
            if (this.sendMessageDeferTimer != null) {
                clearTimeout(this.sendMessageDeferTimer);
            }
            this.cmdQ.cmdMessageQ[0].setPriority(1);
            const nextCmd = this.cmdQ.cmdMessageQ[0];
            
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

            logger.debug('Sending :' + nextCmd.getMessage() + '\\n');
            this.getExpectedResponseTo(nextCmd).then(this.responseHandler.bind(this))
                .catch(function(reject) {
                    logger.warn('Reject: ' + reject.message);
                });
        }
        else
        {
            let multipleStr = 'another time ';
            if (this.sendMessageDeferTimer === null) // first deferal
            {
                logger.debug('Port not yet operational');
                multipleStr = 'first time ';
            }
            logger.debug('==> message deferred ' + multipleStr + 'by '
                         + this.deferalTimeInMs + ' milliseconds');
            clearTimeout(this.sendMessageDeferTimer);
            //sendMessageDeferTimer = setTimeout(this.runMessageQ, 1000, true ) ;
            this.sendMessageDeferTimer = setTimeout(function()
                                                    {
                                                        logger.debug('Running deferred message Q');
                                                        this.runMessageQ();
                                                    }.bind(this), this.deferalTimeInMs);
            // else a new message came in but port not yet operational
            // ==> don't start another timer
        }
    }

    // \details
    //   - Puts the message into the Q
    //   - Starts the Q if not yet running
    //   - Sets a timeout timer after which the first Q element is removed
    // \param message of class Command
    // \param priority in [0; 1]; default 0; 0 = normal, 1 = prioritized (send next)
    // \note It was planned to have a timeout parameter in sendMsg. However
    //       the BMV is so slow that almost any reasonable timeout will expire if
    //       several commands are in the Q. Force command implemented instead.
    sendMsg(message) {
        logger.trace('ReceiverTransmitter::sendMsg: ' + message.toString());
        const isQEmpty = this.cmdQ.isEmpty(); // must be retrieved before Q_push_back

        this.cmdQ.Q_push_back(message);
        if (isQEmpty)
        {
            this.runMessageQ();
        }
    }

    // \brief restart is send straight to the port without queuing
    restart() {
        logger.trace('ReceiverTransmitter::restart');
        logger.debug('ReceiverTransmitter::restart'); //FIXME: temporary
        let command = append_checksum(restartCommand);
        this.port.write(this.package(command)); // the command is fixed :64F\n
    }

    // \brief ensure the message is properly framed before sending to the device
    // \param message without frame
    package(message) {
        return ':' + message.toUpperCase() + '\n';
    }
    
    // \param command is of class Command
    responseTimeoutHandler(command) {
        logger.trace('ReceiverTransmitter::responseTimeoutHandler');
        const commandId = command.getId();
        
        logger.error('timeout - no response to '
                     + command.getMessage() + ' within '
                     + this.cmdResponseTimeoutMS + 'ms');
        this.maxResponseTime += this.cmdResponseTimeoutMS;
        let sendTypeStr = 'Sending next command ';
        if (commandId in this.responseMap)
        {
            sendTypeStr = 'Repeating command ('
                + this.responseMap[commandId].doRetry + ') ';
            // FIXME: after restart the following response received: 4000051
            if (this.responseMap[commandId].doRetry % 5 === 0) this.restart(); // TODO: put 5 as param/config
            if (this.responseMap[commandId].doRetry <= 0)
            {
                // FIXME: don't delete but mark as timedout in case message still arrives
                delete this.responseMap[commandId];

                if (this.cmdQ.delete(commandId) !== isOK)
                    logger.debug('Cmd Q: ' + this.cmdQ.getQLength());
                //reject(new Error('timeout - no response received within 30 secs'));
                sendTypeStr = 'Sending next command ';
            }
        }
        else {
            logger.warn(commandId + ' not in responseMap');
        }
        
        if (! this.cmdQ.isEmpty())
        {
            this.cmdQ.cmdMessageQ[0].setPriority(1);
            const nextCmd = this.cmdQ.cmdMessageQ[0];
            logger.debug(sendTypeStr + ': ' + nextCmd.getMessage());
            this.runMessageQ();
        }
    }

    // \brief Processes the response and removes it from the Q and responseMap
    // \param response is an object of type Response
    // \post  at every exit of responseHandler the Q must be run with the remaining elements
    // \return -1 means the response does not map any queued command
    //        -2 response contained an error
    //        0 response is OK
    responseHandler(response) {
        logger.trace('ReceiverTransmitter::responseHandler: ' + response.toString());
        let receivedTime = new Date();
        let errStatus = isOK;
        this.maxResponseTime = Math.max(this.maxResponseTime,
                                        receivedTime - this.responseMap[response.getId()].sentTime);
        const responseId = response.getId();
        if (response.is(pingResponse) || response.is(doneResponse))
        {
            const commandId  = this.responseMap[responseId].orgCmdId;
            // response contains the message without leading : and trailing \n
            errStatus = this.cmdQ.delete(commandId);
            let value = response.getValue();
            if (commandId === productIdCommand) {
                bmvdata.productId.newValue = value;
                this.updateCacheObject('productId', bmvdata.productId); // ignore returned object
                logger.debug('Product Id response: '
                             + bmvdata.productId.shortDescr + ' '
                             + bmvdata.productId.formatted() + ' - cache updated');
            }
            else { // commandId === versionCommand
                const releaseCandidate = value.charAt(0);
                bmvdata.version.newValue = value.substring(1);
                this.updateCacheObject('version', bmvdata.version); // ignore returned object
                logger.debug('Ping/Version response: '
                             + bmvdata.version.shortDescr + ' ' + bmvdata.version.formatted()
                             + ' release candidate ' + releaseCandidate + ' - cache updated');
            }
        }
        else {
            // response contains the message without leading : and trailing \n
            errStatus = this.cmdQ.delete(responseId);

            if (errStatus === isOK) {
                errStatus = response.getState();
            }
            if (errStatus === isOK) {
                const address = '0x' + response.getAddress();
                if (address in addressCache)
                {
                    // TODO: add sentTime, receivedTime fields to each object
                    addressCache[address].newValue = addressCache[address].fromHexStr(response.getValue());
                    logger.debug('response for ' + address + ': updating cache');
                    // FIXME: addressCache must point to the bmvdata keys!!!
                    // i.e. here updateCacheObject(bmvdata[addressCache[address]]...
                    this.updateCacheObject('FIXME', addressCache[address]); // ignore returned object
                }
                else {
                    logger.warn(address + ' is not in addressCache');
                    // FIXME: the creation of a new object? Does it make sense?
                    //addressCache[address] = new Object();
                    //addressCache[address].newValue = conv.hexToUint(strValue);
                }
            }
            //TODO: if response does not match expected response sendMsg(message, priority) again.
        }
        delete this.responseMap[responseId]; // FIXME: should we leave it in the responseMap and clean it e.g. every 10min

        //this.runMessageQ();
        return errStatus;
    }

    // \param command is of class Command
    getExpectedResponseTo(command) {
        logger.trace('ReceiverTransmitter::getExpectedResponseTo(' + command.toString() + ')');
        let that = this;
        return new Promise(function(resolve, reject)
                           {
                               const expectedResponse = command.getResponse();
                               const responseIdLength = command.getId().length;
                               const responseId = expectedResponse.substring(0, responseIdLength);

                               //var tid = setTimeout(this.responseTimeoutHandler, this.cmdResponseTimeoutMS, command);
                               const tid = setTimeout(
                                   function() // do these params need bind?
                                   {
                                       that.responseTimeoutHandler(command);
                                   }, that.cmdResponseTimeoutMS, command);

                               logger.debug('Timeout set to ' + that.cmdResponseTimeoutMS
                                            + 'ms for ' + responseId)

                               logger.debug('Adding ' + responseId + ' to reponseMap');
                               let newRetries = command.maxRetries;
                               if (responseId in that.responseMap)
                                   newRetries = that.responseMap[responseId].doRetry-1;
                               that.responseMap[responseId] = {
                                   func:    resolve.bind(that),
                                   expect:  expectedResponse,
                                   orgCmdId:command.getId(), // for retrieval in cmd Q
                                   timerId: tid,
                                   doRetry: newRetries,
                                   sentTime: new Date(),
                               };
                               that.port.write(that.package(command.getMessage()));
                               logger.debug(':' + command.getMessage() + '\\n sent to device');
                           });
    }
}



class VitronEnergyDevice {

    constructor() {
        logger.trace('VitronEnergyDevice::constructor');
        if(! VitronEnergyDevice.instance){
            this.rxtx = new ReceiverTransmitter();
            VitronEnergyDevice.instance = this;
            // FIXME: object freeze does not work as it should
            Object.freeze(VitronEnergyDevice);
        }
        return VitronEnergyDevice.instance;
    }


    restart() {
        logger.trace('VitronEnergyDevice::restart');
        this.rxtx.restart();
    }
        
    stop() {
        if (this.rxtx) this.rxtx.close();
    }

    // \param force keep trying until successful
    get(address, priority, force) {
        logger.trace('VitronEnergyDevice::get(address): ' + address);
        let maxRetries = 3;
        if (force)
            // maxRetries = MAX_SAFE_INTEGER not defined
            maxRetries = 999999;
        const command = new Command(getCommand, address, '', priority, maxRetries);
        logger.debug('Command: ' + command);
        this.rxtx.sendMsg(command);
    }

    // \param value must be a string of 4 or 8  characters in hexadecimal
    //        with byte pairs swapped, i.e. 1B83 => 831B
    // \param force in {true, false} keep trying until successful
    set(address, value, priority, force) {
        logger.trace('VitronEnergyDevice::set(address): ' + address);
        let maxRetries = 3;
        if (force)
            // maxRetries = MAX_SAFE_INTEGER not defined
            maxRetries = 999999;
        const command = new Command(setCommand, address, value, priority, maxRetries);
        this.rxtx.sendMsg(command);
        // TODO: validate value is the returned value?!
    }

    // EEE functions (switch on/off display values)
    // FIXME: the following shown functions need addressCache to be created before calling them
    isVoltageShown()
    {
        logger.trace('VitronEnergyDevice::isVoltageShown: ' + address);
        get('0xEEE0');
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
        logger.debug('setSOC: ' + soc + ' as hex-string ' + strSoc);
        this.set('0x0FFF', strSoc); // FIXME: this goes wrong if strSOC = '0020' since that becomes 20 inside set
    }

    getStateOfCharge()
    {
        logger.trace('VitronEnergyDevice::getStateOfCharge');
        this.get('0x0FFF');
    }

    setBatteryCapacity(capacity) {
        logger.trace('VitronEnergyDevice::setBatteryCapacity to ' + capacity);

        let strCapacity = toEndianHexStr(capacity, 2);
        this.set('0x1000', strCapacity);
    };

    getBatteryCapacity()
    {
        logger.trace('VitronEnergyDevice::getBatteryCapacity');
        this.get('0x1000');
    }

    setChargedVoltage(voltage)
    {
        logger.trace('VitronEnergyDevice::setChargedVoltage to ' + voltage);
        let strVoltage = toEndianHexStr(voltage, 2);
        this.set('0x1001', strVoltage);
    }

    getChargedVoltage()
    {
        logger.trace('VitronEnergyDevice::getChargedVoltage');
        this.get('0x1001');
    }

    setTailCurrent(current)
    {
        logger.trace('VitronEnergyDevice::setTailCurrent to ' + current);
        let strCurrent = toEndianHexStr(current, 2);
        this.set('0x1002', strCurrent);
    }

    getTailCurrent()
    {
        logger.trace('VitronEnergyDevice::getTailCurrent');
        this.get('0x1002');
    }

    setChargedDetectTime(time)
    {
        logger.trace('VitronEnergyDevice::setChargedDetectTime to ' + time);
        let strTime = toEndianHexStr(time, 2);
        this.set('0x1003', strTime);
    }

    getChargedDetectTime()
    {
        logger.trace('VitronEnergyDevice::getChargedDetectTime');
        this.get('0x1003');
    }


    setChargeEfficiency(percent)
    {
        logger.trace('VitronEnergyDevice::setChargeEfficiency to ' + percent);
        let strPerc = toEndianHexStr(percent, 2);
        this.set('0x1004', strPerc);
    }

    getChargeEfficiency()
    {
        logger.trace('VitronEnergyDevice::getChargeEfficiency');
        this.get('0x1004');
    }

    setPeukertCoefficient(coeff)
    {
        logger.trace('VitronEnergyDevice::setPeukertCoefficient to ' + coeff);
        let strCoeff = toEndianHexStr(coeff, 2);
        this.set('0x1005', strCoeff);
    }

    getPeukertCoefficient()
    {
        logger.trace('VitronEnergyDevice::getPeukertCoefficient');
        this.get('0x1005');
    }

    setCurrentThreshold(current)
    {
        logger.trace('VitronEnergyDevice::setCurrentThreshold to ' + current);
        let strCurrent = toEndianHexStr(current, 2);
        this.set('0x1006', strCurrent);
    }

    // FIXME: feasble?
    getCurrentThreshold()
    {
        logger.trace('VitronEnergyDevice::getCurrentThreshold');
        this.get('0x1006');
    }

    setTimeToGoDelta(time)
    {
        logger.trace('VitronEnergyDevice::setTimeToGoDelta to ' + time);
        let strTime = toEndianHexStr(time, 2);
        this.set('0x1007', strTime);
    }

    getTimeToGoDelta()
    {
        logger.trace('VitronEnergyDevice::getTimeToGoDelta');
        this.get('0x1007');
    }

    isTimeToGoShown()
    {
        logger.trace('VitronEnergyDevice::isTimeToGoShown');
        this.get('0xEEE6');
    }

    setShowTimeToGo(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowTimeToGo to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE6', strOnOff);
    }

    isTemperatureShown() {
        logger.trace('VitronEnergyDevice::isTemperatureShown');
        this.get('0xEEE7');
    }

    setShowTemperature(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowTemperature to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE7', strOnOff);
    }

    isPowerShown()
    {
        logger.trace('VitronEnergyDevice::isPowerShown');
        this.get('0xEEE8');
    }

    setShowPower(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowPower to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE8', strOnOff);
    }

    setRelayLowSOC(percent)
    {
        logger.trace('VitronEnergyDevice::setRelayLowSOC to ' + percent);
        let strPercent = toEndianHexStr(percent, 2);
        this.set('0x1008', strPercent);
    }

    getRelayLowSOC()
    {
        logger.trace('VitronEnergyDevice::getRelayLowSOC');
        this.get('0x1008');
    }

    setRelayLowSOCClear(percent)
    {
        logger.trace('VitronEnergyDevice::setRelayLowSOCClear to ' + percent);
        let strPercent = toEndianHexStr(percent, 2);
        this.set('0x1009', strPercent);
    }

    getRelayLowSOCClear()
    {
        logger.trace('VitronEnergyDevice::getRelayLowSOCClear');
        this.get('0x1009');
    }

    setUserCurrentZero(count)
    {
        logger.trace('VitronEnergyDevice::setUserCurrentZero to ' + count);
        let strCount = toEndianHexStr(count, 2);
        this.set('0x1034', strCount);
    }

    getUserCurrentZero()
    {
        logger.trace('VitronEnergyDevice::getUserCurrentZero');
        get('0x1034');
    }

    setShowVoltage(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowVoltage to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE0', strOnOff);
    }

    isAuxiliaryVoltageShown()
    {
        logger.trace('VitronEnergyDevice::isAuxiliaryVoltageShown');
        get('0xEEE1');
    }
    
    setShowAuxiliaryVoltage(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowAuxiliaryVoltage to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE1', strOnOff);
    }

    setShowMidVoltage(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowMidVoltage to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE2', strOnOff);
    }

    isCurrentShown()
    {
        logger.trace('VitronEnergyDevice::isCurrentShown');
        this.get('0xEEE3');
    }

    isMidVoltageShown()
    {
        logger.trace('VitronEnergyDevice::isMidVoltageShown');
        this.get('0xEEE2');
    }

    setShowCurrent(onOff)
    {  
        logger.trace('VitronEnergyDevice::setShowCurrent to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE3', strOnOff);
    }

    setShowConsumedAh(onOff)
    {
        logger.trace('VitronEnergyDevice::setShowConsumedAh to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE4', strOnOff);
    }

    isConsumedAhShown()
    {
        logger.trace('VitronEnergyDevice::isConsumedAhShown');
        this.get('0xEEE4');
    }

    setShowStateOfCharge(onOff)
    {
        logger.trace('setShowStateOfCharge to ' + onOff);
        let strOnOff = toEndianHexStr(onOff, 1);
        this.set('0xEEE5', strOnOff);
    }

    isStateOfChargeShown()
    {
        logger.trace('VitronEnergyDevice::isStateOfChargeShown');
        this.get('0xEEE5');
    }

    writeDeviceConfig(newCurrent, oldCurrent, precision, timestamp)
    {
        logger.trace('VitronEnergyDevice::writeDeviceConfig');
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
        logger.debug('Stringify to JSON format');
        let jsonConfig = JSON.stringify(config, null, 2);
        logger.debug(jsonConfig);
        let file = __dirname + '/config.json';
        logger.debug('Writing config to file ' + file);

        let config_file = fs.createWriteStream(file, {flags: 'w'});
        config_file.write(jsonConfig);

        logger.debug('deleting listeners');
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
        logger.trace('VitronEnergyDevice::getDeviceConfig');

        if (doSave) {
            // prepare for saving the data:
            console.log('registering writeDeviceConfig listeners');
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
    set_relay_mode(mode, priority, force) {
        logger.trace('VitronEnergyDevice::set relay mode');

        if (Math.floor(parseInt(addressCache['0x034F'].value)) === mode) return;
        
        // FIXME: set priority 1 (bug: currently not working)
        if (mode === 0)
            this.set('0x034F', '00', priority, force);
        else if (mode === 1)
            this.set('0x034F', '01', priority, force);
        else if (mode === 2)
            this.set('0x034F', '02', priority, force);
    }

    setRelay(mode) {
        // FIXME: prioritizing both set_relay_mode and then setRelay pushes
        //        the setRelay before setting the mode!!! Fix: save prioritization
        //        in cmdMessageQ and do not allow them being pushed.
        logger.trace('VitronEnergyDevice::set relay');
        // FIXME: for being generic, this should be done outside
        const priority = 1;
        const force = true;
        // if setRelay is on force or priority, then set_relay_mode must be too.
        // Otherwise setRelay may 'overtake' set_relay_mode
        this.set_relay_mode(2, priority, force);

        let currentMode = 0;
        if (addressCache['0x034E'].value === 'ON') currentMode = 1;
        if (addressCache['0x034E'].value !== null && currentMode === mode) return;

        // FIXME: set priority 1 (bug: currently not working)
        if (mode === 0)
            this.set('0x034E', '00', priority, force);
        else
            this.set('0x034E', '01', priority, force);
    }

    setAlarm() {
        logger.trace('VitronEnergyDevice::set alarm');
        this.set('0xEEFC', '01');
    }
    
    clearAlarm() {
        logger.trace('VitronEnergyDevice::clear alarm');
        //this.set('0xEEFC', '00');
        this.set('0x031F', '00');
    }

    ping(priority, force) {
        logger.trace('VitronEnergyDevice::ping');
        let maxRetries = 3;
        if (force)
            // maxRetries = MAX_SAFE_INTEGER not defined
            maxRetries = 999999;
        const command = new Command(pingCommand, '', '', priority, maxRetries);
        logger.debug('Command: ' + command);
        this.rxtx.sendMsg(command);
    };

    app_version(priority, force) {
        logger.trace('VitronEnergyDevice::app version');
        let maxRetries = 3;
        if (force)
            // maxRetries = MAX_SAFE_INTEGER not defined
            maxRetries = 999999;
        const command = new Command(versionCommand, '', '', priority, maxRetries);
        logger.debug('Command: ' + command);
        this.rxtx.sendMsg(command);
    }

    productId(priority, force) {
        logger.trace('VitronEnergyDevice::product id');
        let maxRetries = 3;
        if (force)
            // maxRetries = MAX_SAFE_INTEGER not defined
            maxRetries = 999999;
        const command = new Command(productIdCommand, '', '', priority, maxRetries);
        logger.debug('Command: ' + command);
        this.rxtx.sendMsg(command);
    }
    
    // \brief Set or remove a listener (one listener per property)
    // \details Set null to remove the listener.
    //        If property is 'ChangeList' then a map of changed
    //        values is handed over to listener.
    // \param property is one property out of the keys of bmvdata
    //        (i.e. batteryCurrent, alarmState, relayState, ...)
    //        OR the property is ChangeList
    // \param listener is a function with the following interface
    //        listener = function(newValueFormatted, // i.e. rounded to precision and "scaled to SI unit"
    //                            oldValueFormatted, // i.e. rounded to precision and "scaled to SI unit"
    //                            valueReceivedTime, 
    //                            property)            // i.e. reference to bmvdata[property]
    //        newValueFormatted and oldValueFormatted are without units so calculations
    //        can be done easily. The string property allows to address the entire object.
    //        Access to the object gives access to the unit, precision, delta, short description, etc.
    // \note  a function must expect the values in this order, though the function
    //        may not provide arguments for the last entities, e.g.
    //        function(newValueFormatted, oldValueFormatted) can be registered.
    //        newValueFormatted and oldValueFormatted may differ from the object's
    //        values.
    // \see   device_cache.js: function register(.) property formatted
    registerListener(property, listener)
    {
	if (! property || ! listener) return;
        logger.trace('VitronEnergyDevice::registerListener(' + property + ')');
        if (property === 'ChangeList') this.rxtx.registerListener(listener);
        else if (property in bmvdata) {
            bmvdata[property].on.push(listener);
            // send current value at registration as baseline
            listener(bmvdata[property].value,
                     bmvdata[property].value, // first value: newValue = value
                     Date.now(),
                     property);
        }
    }
    
    findListenerIndex(property, listener) {
	for (let i = 0; i < bmvdata[property].on.length; ++i)
	{
	    if (bmvdata[property].on[i] === listener) return i;
	}
    }

    deregisterListener(property, listener)
    {
	if (! property || ! listener) return;
        logger.trace('VitronEnergyDevice::deregisterListener(' + property + ')');
        if (property === 'ChangeList') this.rxtx.deregisterListener(listener);
        else if (property in bmvdata) {
	    let i = findListenerIndex(property, listener);
	    delete bmvdata[property].on[i];
        }
    }
    
    hasListeners(property)
    {
        logger.trace('VitronEnergyDevice::hasListener');
        if (property === 'ChangeList') return this.rxtx.on.length > 0;
        else return (bmvdata[property].on.length > 0);
    }

    update() {
        logger.trace('VitronEnergyDevice::update');
        return bmvdata;
    }
}

// ES6:
// const instance = new VitronEnergyDevice();
// export default instance;
module.exports.VitronEnergyDevice = VitronEnergyDevice;
// add module.exports.VitronEnergyDevice.instance and then freeze the object
// FIXME: make freeze work again!!!
//Object.freeze(exports.VitronEnergyDevice);



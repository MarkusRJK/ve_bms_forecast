
var log4js = require('log4js');
var conv = require('./hexconv');
var fs = require('fs');


const logger = log4js.getLogger('silent');

// Data model:
//
// Each value (volt, current, power, state of charge...) in this device
// cache owns a register on the Vitron Energy device.
//
// All registers are cached in this application's objects
// that also provide conversions, formatters, units, callbacks on change,
// descriptions etc.
//
// Some of these register values are bundled into a package and send
// every 1 second (1-second-updates). Among them are the history values
// (H1, H2, ...) and the most important values like voltage, current,
// power, state of charge.
//
// If a register value is send in the 1-second-update the value may
// be by a factor different from the value read directly from the
// register (e.g. ...)
// 
// For convenience there are 3 maps pointing to the same objects:
//
// addressCache: maps addresses of device registers to objects,
//               e.g. the voltage 'V' is stored in register
//                    at address 0xED8D. When reading the value
//                    directly from the register it needs to be
//                    multiplied by 10 to get millivolts.
// bmvdata:      maps human readable names to the same objects,
//               e.g. 'V' is the upper voltage, hence bmvdata.upperVoltage
// map:          maps the keys of the 1-second-updates to the same objects

// bmvdata maps human readable keys to objects
var bmvdata = {};
bmvdata.isDirty = false;
// map's keys correspond to the keys used in the frequent 2-second-updates
var victronMap = new Map();
// addressCache's keys map the register's addresses to the objects
var addressCache = new Map();


class CacheObject {

    // nativeToUnitFactor == 0 ==> output: unformatted value without units,
    //                             e.g. use for strings
    // nativeToUnitFactor: value[in units] = nativeToUnitFactor * raw value
    // units == "" for unit-less values
    // units == "s" ==> output in format weeks days h m s;
    //                  \pre nativeToUnitFactor must convert to seconds
    constructor(nativeToUnitFactor, units, shortDescr, options) {
        logger.trace("CacheObject::constructor");
        this.isComponentsMapped = false;
        this.value = null;
        this.newValue = null;
        // choose 0 for strings
        this.nativeToUnitFactor = nativeToUnitFactor;
        // e.g. A, V, km/h, % ...
        this.units = units;
        this.shortDescr = shortDescr;
        // initialize defaults for optional parameters:
        this.description = ""; // default
        this.precision = 0.01; // default precision -2 digits after dot
        this.delta = 0.01; // default delta; if delta exceeded a change propagated via on()
        this.on = new Array();
        // if values are read from register instead of the frequent value
        // updates, the values are in hexadecimal string format and may
        // have a different factor that needs to be applied to convert
        // to the same value as the frequent update. This is done by
        // fromHexStr and the inverse function by toHexStr
        this.fromHexStr = conv.hexToUint; // default
        this.toHexStr = null;
        // if options exist, overwrite specific option:
        if (options === undefined) return;
        if (options['description'])
        {
            this.description = options['description'];
        }
        // example: pure int ==> precision := 0; 
        // 2 digits at the right of the decimal point ==> precision := -2
        if (options['precision'])
        {
            this.precision = Math.pow(10, options['precision']);
        }
        if (options['delta'])
        {
            this.delta = Math.pow(10, options['delta']);
        }
        if (options['formatter'])
        {
            this.formatted = options['formatter'];
        }
        if (options['on'])
        {
            this.on.push(options['on']);
        }
        if (options['fromHexStr'])
        {
            this.fromHexStr = options['fromHexStr'];
        }
        if (options['toHexStr'])
        {
            this.toHexStr = options['toHexStr'];
        }
    }

    // format and scale from raw value to unit-value with given precision
    formatted() {
        // TODO: use typeof this.value in 'boolean', 'string', 'number'...
        if (this.value === null || this.nativeToUnitFactor === 0) return this.value;
        // use rounding
        // FIXME: precision = 0 => 1.0/1.0 = 1.0 => l = 3 => toFixed(2) rather than toFixed(0)
        const div = 1.0 / this.precision;
        const l = String(div).length;
        let scaledToIntPrecision = Number(this.value * this.nativeToUnitFactor) + Number.EPSILON;
        scaledToIntPrecision *= div;
        return (Math.round(scaledToIntPrecision) * this.precision).toFixed(l-1);
    }
    
    formattedWithUnit() {
        if (this.units === "s")
        {
            // nativeToSIFactor must convert the value to SI i.e. seconds
            let timeInSecs = Math.round(this.value * this.nativeToUnitFactor);
            let durationStr = "infinity";
            if (timeInSecs >= 0) durationStr = this.formatSeconds(timeInSecs);
            return durationStr;
        }
        else if (this.nativeToUnitFactor === 0) return this.value;
        else return this.formatted() + " " + this.units;
    }

    formatSeconds(duration) {
        if (duration == -1 || duration === undefined || duration === null) return "infinite";

        let base    = 60;
        // duration in seconds
        let seconds = duration % base;
        duration    = Math.floor(duration / base); // in minutes
        let minutes = duration % base;
        duration    = Math.floor(duration / base); // in hours
        base = 24;
        let hours   = duration % base;
        duration    = Math.floor(duration / base); // in days
        base = 7;
        const days    = duration % base;
        duration    = Math.floor(duration / base); // in weeks
        const weeks   = duration;

        const weekStr = (weeks > 0) ? weeks + ((weeks == 1) ? " week" : " weeks") : "";
        const dayStr  = (days  > 0) ? days  + ((days  == 1) ? " day"  : " days")  : "";
        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        return weekStr + " " + dayStr + " " + hours + "h " + minutes + "m " + seconds + "s";
    }

    getProductLongname(pid) {
        logger.trace('getProductLongname');
        if (pid === parseInt("0x203" )) return("BMV-700");
        if (pid === parseInt("0x204" )) return("BMV-702");
        if (pid === parseInt("0x205" )) return("BMV-700H");
        if (pid === parseInt("0xA381")) return("BMV-712");
        if (pid === parseInt("0x300" )) return("BlueSolar MPPT 70/15");        // model phased out
        if (pid === parseInt("0xA04C")) return("BlueSolar MPPT 75/10");
        if (pid === parseInt("0xA042")) return("BlueSolar MPPT 75/15");
        if (pid === parseInt("0xA040")) return("BlueSolar MPPT 75/50");        // model phased out
        if (pid === parseInt("0xA043")) return("BlueSolar MPPT 100/15");
        if (pid === parseInt("0xA044")) return("BlueSolar MPPT 100/30");       // model phased out
        if (pid === parseInt("0xA04A")) return("BlueSolar MPPT 100/30 rev 2");
        if (pid === parseInt("0xA045")) return("BlueSolar MPPT 100/50 rev 1"); // model phased out
        if (pid === parseInt("0xA049")) return("BlueSolar MPPT 100/50 rev 2");
        if (pid === parseInt("0xA041")) return("BlueSolar MPPT 150/35 rev 1"); // model phased out
        if (pid === parseInt("0xA04B")) return("BlueSolar MPPT 150/35 rev 2");
        if (pid === parseInt("0xA04D")) return("BlueSolar MPPT 150/45");
        if (pid === parseInt("0xA04E")) return("BlueSolar MPPT 150/60");
        if (pid === parseInt("0xA046")) return("BlueSolar MPPT 150/70");
        if (pid === parseInt("0xA04F")) return("BlueSolar MPPT 150/85");
        if (pid === parseInt("0xA047")) return("BlueSolar MPPT 150/100");
        if (pid === parseInt("0xA051")) return("SmartSolar MPPT 150/100");
        if (pid === parseInt("0xA050")) return("SmartSolar MPPT 250/100");
        if (pid === parseInt("0xA201")) return("Phoenix Inverter 12V 250VA 230V");
        if (pid === parseInt("0xA202")) return("Phoenix Inverter 24V 250VA 230V");
        if (pid === parseInt("0xA204")) return("Phoenix Inverter 48V 250VA 230V");
        if (pid === parseInt("0xA211")) return("Phoenix Inverter 12V 375VA 230V");
        if (pid === parseInt("0xA212")) return("Phoenix Inverter 24V 375VA 230V");
        if (pid === parseInt("0xA214")) return("Phoenix Inverter 48V 375VA 230V");
        if (pid === parseInt("0xA221")) return("Phoenix Inverter 12V 500VA 230V");
        if (pid === parseInt("0xA222")) return("Phoenix Inverter 24V 500VA 230V");
        if (pid === parseInt("0xA224")) return("Phoenix Inverter 48V 500VA 230V");
        if (pid) logger.warn("getProductLongname: Unknown product: " + pid);
        return ("Unknown");
    };

    // \param pid is bmvdata.productId.value
    mapComponents(pid) {
        logger.trace('mapComponents(' + pid + ')');
        if (!pid || this.isComponentsMapped) return;
        try {
            let c = null;
            switch (pid) {
            case parseInt("0x204"):
                logger.debug('mapComponents: importing device_module_bmv.js');
                c = require('./device_module_bmv.js');
                c.mapComponents(bmvdata, addressCache);
                break;

            default:
                break;
            }
            this.isComponentsMapped = true; // place at end of try!
        }
        catch (err) {
            logger.error('mapComponents: ' + err);
        }
    }

    getAlarmText(alarmcode) {
        // BMV alarms + Phoenix Inverter alarms
        if (alarmcode & 0x0001) return("Low voltage");
        if (alarmcode & 0x0002) return("High voltage");
        if (alarmcode & 0x0020) return("Low temperature");
        if (alarmcode & 0x0040) return("High temperature");
        // BMV (only) alarms
        if (alarmcode & 0x0004) return("Low state of charge (SOC)");
        if (alarmcode & 0x0008) return("Low starter voltage");
        if (alarmcode & 0x0010) return("High starter voltage");
        if (alarmcode & 0x0080) return("Mid voltage");
        // Phoenix Inverter alarms
        if (alarmcode & 0x0100) return("Overload");
        if (alarmcode & 0x0200) return("DC-ripple");
        if (alarmcode & 0x0400) return("Low V AC out");
        if (alarmcode & 0x0800) return("High V AC out");
        if (alarmcode > 0x0FFF) logger.warn("getAlarmText: Unknown alarm code: " + alarmcode);
        return("no alarm");
    };

    getStateOfOperationText(state) {
        // State of operation
        switch(state) {
        case    '0': // applies to MPPT and Inverter
            return("OFF");
        case    '1': // applies to Inverter
            return("Low power"); // load search
        case    '2': // applies to MPPT and Inverter
            return("Fault"); // off until user reset
        case    '3': // applies to MPPT
            return("Bulk");
        case    '4': // applies to MPPT
            return("Absorption");
        case    '5': // applies to MPPT
            return("Float");
        case    '9': // applies to Inverter
            return("Inverting"); // on
        }
        logger.warn("getStateOfOperationText: Unknown charge state: " + state);
        return("unknown");
    };

    getDeviceModeText(mode) {
        switch(mode) {
        case    '2':
            return("Inverter");
        case    '4':
            return("Off");
        case    '5':
            return("Eco");
        }
        logger.warn("getDeviceModeText: Unknown mode: " + mode);
        return("unknown");
    };

    getErrorText(errorCode) {
        switch(errorCode) {
        case    '0':
            return("No error");
        case    '2':
            return("Battery voltage too high");
        case    '17':
            return("Charger temperature too high");
        case    '18':
            return("Charger over current");
        case    '19': // can be ingored; regularly occurs during start-up or shutdown
            return("Charger current reversed");
        case    '20':
            return("Bulk time limit exceeded");
        case    '21': // can be ignored for 5 minutes; regularly occurs during start-up or shutdown
            return("Current sensor issue (sensor bias/sensor broken)");
        case    '26':
            return("Terminals overheated");
        case    '33':
            return("Input voltage too high (solar panel)");
        case    '34':
            return("Input current too high (solar panel)");
        case    '38':
            return("Input shutdown (due to excessive battery voltage)");
        case    '116':
            return("Factory calibration data lost");
        case    '117':
            return("Invalid/incompatible firmware");
        case    '119':
            return("User settings invalid");
        }
        logger.warn("getErrorText: Unknown error code: " + errorCode);
        return("unknown");
    };
}

// For dynamical registration of objects as they come in from the Victron unit.
// Dynamical registration saves about 50 objects when operating with BMV-702
// (34 instead of all 84 objects).
function registerComponent(key) {
    logger.trace("registerComponent(" + key + ")");
    // component:  your given name
    // n2UF:       nativeToUnitFactor (output value = n2UF * BMV_value)
    // units:      Ampere, Volts etc. the units must fit the n2UF 
    // shortDescr: used as label for the value
    // options:    list of key values, known keys: precision, description, formatter
    //             precision: negative: -n; round to n digits right to the decimal separator
    //                        zero:      0; round to integer
    //                        positive: +n; round to the n-th digit left from decimal separator
    //                        default:  -2; round to 2 digits right to the decimal separator
    //
    // Each registration line is as follows:
    // bmvdata.<component> = new CacheObject(<n2UF>, <units>, <shortDescr>, <options>);

    switch (String(key)) {
    case 'AR':
        // Monitored values:
        // BMV600, BMV700, Phoenix Inverter
        bmvdata.alarmReason         = new CacheObject(1,      "",    "Alarm reason",
                                                      {'precision': 0, 'formatter' : function() 
                                                       {
                                                           return this.getAlarmText(this.value);
                                                       }});
        // the key of the map is a string identifier that comes with the value sent by BMV
        victronMap.set('AR', bmvdata.alarmReason);
        addressCache.set('0xEEFC', bmvdata.alarmReason);
        break;

    case 'I':
        // BMV600, BMV700, MPPT - Type Sn16; Unit: 0.1A!!!
        // On BMV-712 >v4.01 and BMV-70x >v3.09: Type: Sn32; Unit: 0.001A
        bmvdata.batteryCurrent      = new CacheObject(0.001,  "A",   "Battery Current",
                                                      {'fromHexStr': (hex) => { return 100 * conv.hexToSint(hex); } });
        victronMap.set('I', bmvdata.batteryCurrent);
        addressCache.set('0xED8F', bmvdata.batteryCurrent);
        // only on BMV-712 > v4.01 and BMV-70x > v3.09: is might be address '0xED8C'
        break;

    case 'IL':
        // MPPT
        bmvdata.loadCurrent         = new CacheObject(0.001,  "A",   "Load Current");
        victronMap.set('IL', bmvdata.loadCurrent);
        break;

    case 'LOAD':
        // MPPT - returns string 'ON' or 'OFF'
        bmvdata.load                = new CacheObject(0,      "",    "Load Output State",
                                                      { 'fromHexStr': conv.hexToOnOff });
        victronMap.set('LOAD', bmvdata.load);
        break;

    case 'V':
        // BMV600, BMV700, MPPT, Phoenix Inverter - Display: MAIN; Type: Sn16; Unit: 0.01V!!!
        bmvdata.upperVoltage        = new CacheObject(0.001,  "V",   "Main Voltage",
                                                      { 'description': "Main (Battery) Voltage",
                                                        'precision': -1,
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        victronMap.set('V', bmvdata.upperVoltage);
        // not to be used: addressCache.set('0xED8D', bmvdata.upperVoltage);
        break;

    case 'VM':
        // BMV700 - Display: MID; Type: Un16; Units: 0.01V!!! (only BMV-702 and BMV-712)
        bmvdata.midVoltage          = new CacheObject(0.001,  "V",   "Mid Voltage",
                                                      { 'description': "Mid-point Voltage of the Battery Bank",
                                                        'precision': -1,
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        // only on BMV-702 and BMV-712
        victronMap.set('VM', bmvdata.midVoltage);
        addressCache.set('0x0382', bmvdata.midVoltage);
        break;

    case 'P':
        // BMV700 - Type: Sn16; Unit: W
        bmvdata.instantPower        = new CacheObject(1.0,    "W",   "Instantaneous Power",
                                                      {'fromHexStr': conv.hexToSint });
        victronMap.set('P', bmvdata.instantPower);
        addressCache.set('0xED8E', bmvdata.instantPower);
        break;

    case 'SOC':
        // BMV600, BMV700 - Type: Un16; Unit: 0.01%!!! for 0x0FFF
        //                  Type: Un8 for 0xEEB6 ??? (Synchronisation State)
        bmvdata.stateOfCharge       = new CacheObject(0.1,    "%",   "State of charge",
                                                      { 'precision': -1,
                                                        'fromHexStr' : (hex) => { return 0.1 * conv.hexToUint(hex); } });
        victronMap.set('SOC', bmvdata.stateOfCharge);
        addressCache.set('0x0FFF', bmvdata.stateOfCharge);
        break;

    case 'VS':
        // BMV600, BMV700 - Display: AUX; Type: Sn16; Unit: 0.01V!!! (not available on BMV-702 and BMV-712)
        bmvdata.auxVolt             = new CacheObject(0.001,  "V",   "Aux. Voltage",
                                                      { 'precision': -1, 'description': "Auxiliary (starter) Voltage",
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        // only on BMV-702 and BMV-712
        victronMap.set('VS', bmvdata.auxVolt);
        addressCache.set('0xED7D', bmvdata.auxVolt);
        break;

    case 'CE':
        // BMV600, BMV700 - Type: Sn32; Unit: 0.1 Ah!!!
        bmvdata.consumedAh          = new CacheObject(0.001,  "Ah",  "Consumed",
                                                      { 'description': "Consumed Ampere Hours",
                                                        'fromHexStr': (hex) => { return 100 * conv.hexToSint(hex); } });
        victronMap.set('CE', bmvdata.consumedAh);
        addressCache.set('0xEEFF', bmvdata.consumedAh);
        break;

    case 'DM':
        // BMV700 - Display: MID; Type: Sn16; Units: 0.1 %
        bmvdata.midDeviation        = new CacheObject(1.0,    "%",   "Mid Deviation",
                                                      { 'description': "Mid-point Deviation of the Battery Bank",
                                                        'fromHexStr' : conv.hexToSint });
        // only on BMV-702 and BMV-712
        victronMap.set('DM', bmvdata.midDeviation);
        addressCache.set('0x0383', bmvdata.midDeviation);
        break;

    case 'VPV':
        // MPPT
        bmvdata.panelVoltage        = new CacheObject(0.001,  "V",   "Panel Voltage");
        victronMap.set('VPV', bmvdata.panelVoltage);
        break;

    case 'PPV':
        // MPPT
        bmvdata.panelPower          = new CacheObject(1.0,    "W",   "Panel Power");
        victronMap.set('PPV', bmvdata.panelPower);
        break;

    case 'CS':
        // MPPT, Phoenix Inverter
        bmvdata.stateOfOperation    = new CacheObject(0,      "",    "State of Operation",
                                                      {'formatter' : function() 
                                                       {
                                                           return this.getStateOfOperationText(this.value);
                                                       }});
        victronMap.set('CS', bmvdata.stateOfOperation);
        break;

    case 'PID':
        // BMV700, MPPT, Phoenix Inverter
        bmvdata.productId           = new CacheObject(0,      "",    "Product ID",
                                                      {'formatter' : function() 
                                                       {
                                                           this.mapComponents(bmvdata.productId.value);
                                                           return this.getProductLongname(this.value);
                                                       }});
        victronMap.set('PID', bmvdata.productId);
        break;

    case 'FW':
        // BMV600, BMV700, MPPT, Phoenix Inverter
        bmvdata.version             = new CacheObject(0.01,  "",     "Firmware version");
        victronMap.set('FW', bmvdata.version);
        break;
        
    // History values
    case'H1':
        // BMV600, BMV700
        bmvdata.deepestDischarge    = new CacheObject(0.001, "Ah",   "Deepest Discharge",
                                                      { 'precision': -2, 'description': "Depth of deepest discharge",
                                                        'fromHexStr' : (hex) => { return 100 * conv.hexToSint(hex); } });
        victronMap.set('H1', bmvdata.deepestDischarge);
        addressCache.set('0x0300', bmvdata.deepestDischarge);
        break;

    case 'H2':
        // BMV600, BMV700
        bmvdata.maxAHsinceLastSync  = new CacheObject(0.001, "Ah",   "Last Discharge",
                                                      { 'precision': 0, 'description': "Depth of last discharge", // Max Discharge since sync
                                                        'fromHexStr': (hex) => { return 100 * conv.hexToSint(hex); } });
        victronMap.set('H2', bmvdata.maxAHsinceLastSync);
        addressCache.set('0x0301', bmvdata.maxAHsinceLastSync);
        break;

    case 'H3':
        // BMV600, BMV700
        bmvdata.avgDischarge        = new CacheObject(0.001, "Ah",   "Avg. Discharge",
                                                      { 'description': "Depth of average discharge",
                                                        'fromHexStr' : (hex) => { return 100 * conv.hexToSint(hex); }});
        victronMap.set('H3', bmvdata.avgDischarge);
        addressCache.set('0x0302', bmvdata.avgDischarge);
        break;

    case 'H4':
        // BMV600, BMV700
        bmvdata.chargeCycles        = new CacheObject(1.0,   "",     "Charge Cycles",
                                                      { 'description': "Number of charge cycles" });
        victronMap.set('H4', bmvdata.chargeCycles);
        addressCache.set('0x0303', bmvdata.chargeCycles);
        break;

    case 'H5':
        // BMV600, BMV700
        bmvdata.fullDischarges      = new CacheObject(1.0,   "",     "Full Discharges",
                                                      { 'description': "Number of full discharges" });
        victronMap.set('H5', bmvdata.fullDischarges);
        addressCache.set('0x0304', bmvdata.fullDischarges);
        break;

    case 'H6':
        // BMV600, BMV700
        bmvdata.drawnAh             = new CacheObject(0.001, "Ah",   "Cum. Ah drawn",
                                                      { 'fromHexStr': (hex) => { return 100 * conv.hexToSint(hex); }});
        victronMap.set('H6', bmvdata.drawnAh);
        addressCache.set('0x0305', bmvdata.drawnAh);
        break;

    case 'H7':
        // BMV600, BMV700
        bmvdata.minVoltage          = new CacheObject(0.001, "V",    "Min. Voltage",
                                                      { 'description': "Minimum Main (Battery) Voltage",
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        victronMap.set('H7', bmvdata.minVoltage);
        addressCache.set('0x0306', bmvdata.minVoltage);
        break;

    case 'H8':
        // BMV600, BMV700
        bmvdata.maxVoltage          = new CacheObject(0.001, "V",    "Max. Voltage",
                                                      { 'description': "Maximum Main (Battery) Voltage",
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        victronMap.set('H8', bmvdata.maxVoltage);
        addressCache.set('0x0307', bmvdata.maxVoltage);
        break;

    case 'H9':
        // BMV600, BMV700
        bmvdata.timeSinceFullCharge = new CacheObject(1.0,   "s",    "Time since Full Charge",
                                                      { 'description': "Number of seconds since full charge" });
        victronMap.set('H9', bmvdata.timeSinceFullCharge);
        addressCache.set('0x0308', bmvdata.timeSinceFullCharge);
        break;

    case 'H10':
        // BMV600, BMV700
        bmvdata.noAutoSyncs         = new CacheObject(1,     "",     "Auto. Syncs",
                                                      { 'description': "Number of automatic synchronisations" });
        victronMap.set('H10', bmvdata.noAutoSyncs);
        addressCache.set('0x0309',  bmvdata.noAutoSyncs);
        break;

    case 'H11':
        // BMV600, BMV700
        // FIXME: precision: 0 not working in low/high volt alarms (particularly 0 is the issue)
        bmvdata.lowVoltageAlarms    = new CacheObject(1,     "",     "Low Volt. Alarms",
                                                      { 'description': "Number of Low Main Voltage Alarms", 'precision': -1 });
        victronMap.set('H11', bmvdata.lowVoltageAlarms);
        addressCache.set('0x030A', bmvdata.lowVoltageAlarms);
        break;

    case 'H12':
        // BMV600, BMV700
        bmvdata.highVoltageAlarms   = new CacheObject(1,     "",     "High Volt. Alarms",
                                                      { 'description': "Number of High Main Voltage Alarms", 'precision': -1 });
        victronMap.set('H12', bmvdata.highVoltageAlarms);
        addressCache.set('0x030B', bmvdata.highVoltageAlarms);
        break;

    case 'H13':
        // BMV600
        bmvdata.lowAuxVoltageAlarms = new CacheObject(1,     "",     "Low Aux. Volt. Alarms",
                                                      { 'description': "Number of Low Auxiliary Voltage Alarms" });
        victronMap.set('H13', bmvdata.lowAuxVoltageAlarms);
        break;

    case 'H14':
        // BMV600
        bmvdata.highAuxVoltageAlarms= new CacheObject(1,     "",     "High Aux. Volt. Alarms",
                                                      { 'description': "Number of High Aux. Voltage Alarms" });
        victronMap.set('H14', bmvdata.highAuxVoltageAlarms);
        break;

    case 'H15':
        // BMV600, BMV700
        bmvdata.minAuxVoltage       = new CacheObject(0.001, "V",    "Min. Aux. Volt.",
                                                      { 'description': "Minimal Auxiliary (Battery) Voltage",
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        victronMap.set('H15', bmvdata.minAuxVoltage);
        addressCache.set('0x030E', bmvdata.minAuxVoltage);
        break;

    case 'H16':
        // BMV600, BMV700
        bmvdata.maxAuxVoltage       = new CacheObject(0.001, "V",    "Max. Aux. Volt.",
                                                      { 'description': "Maximal Auxiliary (Battery) Voltage",
                                                        'fromHexStr': (hex) => { return 10 * conv.hexToSint(hex); }});
        victronMap.set('H16', bmvdata.maxAuxVoltage);
        addressCache.set('0x030F', bmvdata.maxAuxVoltage);
        break;

    case 'H17':
        // BMV700
        bmvdata.dischargeEnergy     = new CacheObject(0.01,  "kWh",  "Drawn Energy",
                                                      { 'description': "Amount of Discharged Energy" });
        victronMap.set('H17', bmvdata.dischargeEnergy);
        addressCache.set('0x0310', bmvdata.dischargeEnergy);
        break;

    case 'H18':
        // BMV700
        bmvdata.absorbedEnergy      = new CacheObject(0.01,  "kWh",  "Absorbed Energy",
                                                      { 'description': "Amount of Charged Energy" });
        victronMap.set('H18', bmvdata.absorbedEnergy);
        addressCache.set('0x0311', bmvdata.absorbedEnergy);
        break;

    case 'H19':
        // MPPT
        bmvdata.yieldTotal          = new CacheObject(0.01,  "kWh",  "Yield Total",
                                                      { 'description': "User resettable counter" });
        victronMap.set('H19', bmvdata.yieldTotal);
        break;

    case 'H20':
        // MPPT
        bmvdata.yieldToday          = new CacheObject(0.01,  "kWh",  "Yield Today");
        victronMap.set('H20', bmvdata.yieldToday);
        break;

    case 'H21':
        // MPPT
        bmvdata.maxPowerToday       = new CacheObject(1.0,   "W",    "Max. Power Today");
        victronMap.set('H21', bmvdata.maxPowerToday);
        break;

    case 'H22':
        // MPPT
        bmvdata.yieldYesterday      = new CacheObject(0.01,  "kWh",  "Yield Yesterday");
        victronMap.set('H22', bmvdata.yieldYesterday);
        break;

    case 'H23':
        // MPPT
        bmvdata.maxPowerYesterday   = new CacheObject(1.0,   "W",    "Max. Power Yesterday");
        victronMap.set('H23', bmvdata.maxPowerYesterday);
        break;

    case 'ERR':
        // MPPT
        bmvdata.errorCode           = new CacheObject(1,     "",     "MPPT Error Code",
                                                      {'formatter' : function() 
                                                       {
                                                           return this.getErrorText(this.value);
                                                       }});
        victronMap.set('ERR', bmvdata.errorCode);
        break;

    case 'WARN':
        // Phoenix Inverter
        bmvdata.warnReason          = new CacheObject(0,     "",     "Warning Reason");
        victronMap.set('WARN', bmvdata.warnReason);
        break;

    case 'SER#':
        // MPPT, Phoenix Inverter
        bmvdata.serialNumber        = new CacheObject(0,     "",     "Serial Number");
        victronMap.set('SER#', bmvdata.serialNumber);
        break;

    case 'HSDS':
        // BlueSolar MPPT - returns 0WARNWARNWARN..364
        bmvdata.daySequenceNumber   = new CacheObject(1,     "",     "Day Sequence Number");
        victronMap.set('HSDS', bmvdata.daySequenceNumber);
        break;

    case 'MODE':
        // Phoenix Inverter
        bmvdata.deviceMode          = new CacheObject(1,     "",     "Device Mode",
                                                      {'formatter' : function() 
                                                       {
                                                           return this.getDeviceModeText(this.value);
                                                       }});
        victronMap.set('MODE', bmvdata.deviceMode);
        break;

    case 'AC_OUT_V':
        // Phoenix Inverter
        bmvdata.ACoutVoltage        = new CacheObject(0.01,"V",    "AC Output Voltage");
        victronMap.set('AC_OUT_V', bmvdata.ACoutVoltage);
        break;

    case 'AC_OUT_I':
        // Phoenix Inverter
        bmvdata.ACoutCurrent        = new CacheObject(0.1, "A",    "AC Output Current");
        victronMap.set('AC_OUT_I', bmvdata.ACoutVoltage);
        break;

    case 'TTG':
        // BMV600, BMV700 - Type: Un16; Units: minutes
        bmvdata.timeToGo            = new CacheObject(60.0,  "s",    "Time to go",
                                                      {'description': "Time until discharged" });
        victronMap.set('TTG', bmvdata.timeToGo);
        addressCache.set('0x0FFE', bmvdata.timeToGo);
        break;

    case 'Alarm':
        // BMV600, BMV700 - returns string 'ON' or 'OFF'
        bmvdata.alarmState          = new CacheObject(0,   "",       "Alarm state",
                                                      {'description': "Alarm condition active",
                                                       'fromHexStr': conv.hexToOnOff
                                                      });
        victronMap.set('Alarm', bmvdata.alarmState);
        break;
        
    case 'Relay':
        // BMV600, BMV700, SmartSolar MPPT - returns string 'ON' or 'OFF'
        bmvdata.relayState          = new CacheObject(0,   "",       "Relay state",
                                                      { 'fromHexStr': conv.hexToOnOff
                                                      });
        victronMap.set('Relay', bmvdata.relayState);
        // FIXME: how does this value behave with the inversion of the relay?
        addressCache.set('0x034E', bmvdata.relayState);
        break;

    case 'BMV':
        // BMV600, BMV700
        bmvdata.modelDescription    = new CacheObject(0,   "",       "Model Description");
        victronMap.set('BMV', bmvdata.modelDescription);
        break;

    default:
        // FIXME: the following keys 'Cap', 'CV', 'TC' etc do not exist in the
        //        frequent updates...
        logger.warn('registerComponent: ' + key
                    + ' is not a known key of a Victron device');
        break;
    }
}



exports.bmvdata = bmvdata;
exports.victronMap = victronMap;
exports.addressCache = addressCache;
module.exports.CacheObject = CacheObject;
module.exports.registerComponent = registerComponent;

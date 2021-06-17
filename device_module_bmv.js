'use strict';

const CacheObject = require('./device_cache.js').CacheObject;
const conv = require('./hexconv');

// creates and maps those components that are not covered by the frequent
// updates coming from the device
function mapComponents(bmvdata, addressCache) {
    // Battery settings: all of Type Un16 except UserCurrentZero
    bmvdata.capacity            = new CacheObject(1,   "Ah",     "Battery capacity");
    addressCache.set('0x1000', bmvdata.capacity);

    bmvdata.chargedVoltage      = new CacheObject(0.1,   "V",      "Charged voltage");
    addressCache.set('0x1001', bmvdata.chargedVoltage);

    bmvdata.tailCurrent         = new CacheObject(0.1,   "%",      "Tail current");
    addressCache.set('0x1002', bmvdata.tailCurrent);

    bmvdata.chargedDetectTime   = new CacheObject(1,   "min",    "Charged detection time");
    addressCache.set('0x1003', bmvdata.chargedDetectTime);

    bmvdata.chargeEfficiency    = new CacheObject(1,   "%",      "Charge efficiency");
    addressCache.set('0x1004', bmvdata.chargeEfficiency);

    bmvdata.peukertCoefficient  = new CacheObject(0.01,   "",      "Peukert coefficiency");
    addressCache.set('0x1005', bmvdata.peukertCoefficient);

    bmvdata.currentThreshold    = new CacheObject(0.01,    "A",     "Current threshold");
    addressCache.set('0x1006', bmvdata.currentThreshold);

    bmvdata.timeToGoDelta       = new CacheObject(1,    "min",   "Time to go Delta T");
    addressCache.set('0x1007', bmvdata.timeToGoDelta);

    bmvdata.relayLowSOC         = new CacheObject(0.1,    "%",     "Relay low SOC");
    addressCache.set('0x1008', bmvdata.relayLowSOC);

    bmvdata.relayLowSOCClear    = new CacheObject(0.1,"%",    "Relay low SOC clear");
    // UCZ is of Type: Sn16; Read-Only
    addressCache.set('0x1009', bmvdata.relayLowSOCClear);

    bmvdata.userCurrentZero     = new CacheObject(1,    "",      "User current zero",
                                           { 'fromHexStr': conv.hexToSint });
    addressCache.set('0x1034', bmvdata.userCurrentZero);

    bmvdata.relayMode           = new CacheObject(1,   "",       "Relay mode");
    addressCache.set('0x034F', bmvdata.relayMode);

    // only available on BMV-702 and BMV-712: Type: Un16; Unit: 0.01 K!!!
    bmvdata.batteryTemp         = new CacheObject(0.01, "°C",    "Battery Temperature");
    addressCache.set('0xEDEC', bmvdata.batteryTemp);

    //bmvdata.syncState           = new CacheObject(1,   "",       "Synchronisation State");
    //addressCache.set('0xEEB6', bmvdata.stateOfCharge); // FIXME: what is this really?

    // Show/don't show certain parameters on BMV
    bmvdata.showVoltage         = new CacheObject(1,   "",       "Show voltage");
    addressCache.set('0xEEE0', bmvdata.showVoltage);

    bmvdata.showAuxVoltage      = new CacheObject(1,   "",       "Show auxiliary voltage");
    addressCache.set('0xEEE1', bmvdata.showAuxVoltage);

    bmvdata.showMidVoltage      = new CacheObject(1,   "",       "Show mid voltage");
    addressCache.set('0xEEE2', bmvdata.showMidVoltage);

    bmvdata.showCurrent         = new CacheObject(1,   "",       "Show current");
    addressCache.set('0xEEE3', bmvdata.showCurrent);

    bmvdata.showConsumedAH      = new CacheObject(1,   "",       "Show consumed AH");
    addressCache.set('0xEEE4', bmvdata.showConsumedAH);

    bmvdata.showSOC             = new CacheObject(1,   "",       "Show SOC");
    addressCache.set('0xEEE5', bmvdata.showSOC);

    bmvdata.showTimeToGo        = new CacheObject(1,   "",       "Show time to go");
    addressCache.set('0xEEE6', bmvdata.showTimeToGo);

    bmvdata.showTemperature     = new CacheObject(1,   "",       "Show temperature");
    addressCache.set('0xEEE7', bmvdata.showTemperature);

    bmvdata.showPower           = new CacheObject(1,   "",       "Show power");
    addressCache.set('0xEEE8', bmvdata.showPower);
};

module.exports.mapComponents = mapComponents;

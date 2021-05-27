'use strict';

const Math = require('mathjs');
const request = require('request');
var fs = require('fs');

var log_stdout = process.stdout;

let apiKey = 'c02463890b91a002fb8709c1ca04987b';
let lat=53.4853;
let lon=-6.152;

// Hourly forecast for 48 hours
let url = `https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts&units=metric&appid=${apiKey}`



class SolarAltitude {

    constructor() {
	console.log("SolarAltitude()");
	// FIXME: set the latest sunrise time and the earliest sunset
	//        time for the latitude on 21/12 as initialization
	this.sunrise = 0;
	this.sunset  = 0;
    }

    getSunrise() {
	return this.sunrise;
    }

    getSunset() {
	return this.sunset;
    }

    setSunrise(t) {
	this.sunrise = t;
	console.log("Sunrise: " + this.sunrise);
    }

    setSunset(t) {
	this.sunset = t;
	console.log("Sunset:  " + this.sunset);
    }
}

var solarState = new SolarAltitude();

function updateForecast() {
    let url = `https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts&units=metric&appid=${apiKey}`
    request(url, function (error, response, body) {
	if(error){
	    console.log('ERROR:', error);
	} else {
	    console.log('body:', body);
	    let weather = null;
	    try {	
	    	weather = JSON.parse(body);
	    	solarState.setSunrise(weather.current.sunrise);
	    	solarState.setSunset(weather.current.sunset);
	    }
	    catch(err) {
	    	console.log("ERROR: could not parse weather; ", err);
	    }
	}
    });
}

updateForecast();
// get forecast every hour: 1000 * 60 * 60 = 3600000
setInterval(updateForecast, 3600000);


module.exports.solarState = solarState;

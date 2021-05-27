const express = require('express');
var path = require('path');
var favicon = require('static-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser'); // const?
var session = require('express-session'); //const?
var bodyParser = require('body-parser'); 

var routes = require('./routes/index');
var users = require('./routes/users');

const app = express();

//const vedirectclass = require( 've_bms_forecast' ).VitronEnergyDevice;
//const vedirect = new vedirectclass();
const vedirect = require( './bms' ).BMSInstance;
var solarState = require( './forecast' ).solarState;

function startBMS() {
    try {
	console.log("trying to start vedirect");
	vedirect.start();
	console.log("success starting vedirect");
    }
    catch(err)
    {
	//logger.debug(err);
	console.log(err);
	console.log("deferring to start vedirect");
	setTimeout(startBMS, 2000)
    }
}
startBMS();

const Math = require('mathjs');

// FIXME: terminal does not work anymore in parallel to webserver
//var bmvterminal = require("./bmv-terminal.js");

var messageId = 0;
var clientCtr = 0;


// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(favicon());
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded());
app.use(cookieParser());

function sseDemo(req, res) {

    var portListener = function(newValue, oldValue, timeStamp, key)
    {
        //console.log("app.js: received " + newValue + " " + oldValue + " " + timeStamp + " " + key);

	const bmvdata = vedirect.update();
        let current   = bmvdata.batteryCurrent.formatted();
        // let topSOC    = getBestEstimateTopSOC(current).toFixed(1);
        // let bottomSOC = getBestEstimateBottomSOC(current).toFixed(1);

        // let minSOC;
        // if (topSOC && bottomSOC)
        //     minSOC = Math.min(topSOC, bottomSOC);
        // if ((isNaN(bmvdata.stateOfCharge.value)) || bmvdata.stateOfCharge.value * 0.1 > 100
        //     || bmvdata.stateOfCharge.value * 0.1 < 0)
        //     if (minSOC) vedirect.setStateOfCharge(minSOC);
        // if (minSOC && Math.abs(bmvdata.stateOfCharge.value * 0.1 - minSOC) >=1)
        // {
        //     vedirect.setStateOfCharge(minSOC);
        // }

        // FIXME: temp mods to alarmState for testing
        //if (messageId < 30)
        //   bmvdata.alarmState.value = "ON";
        //else bmvdata.alarmState.value = "OFF";

        // lowerSOC, upperSOC unformatted without units
        let socL = vedirect.getLowerSOC();
        let socU = vedirect.getUpperSOC();
        let data = {
            'alarmState' : bmvdata.alarmState.value,
            'relayState' : bmvdata.relayState.value,
            'alarmReason': bmvdata.alarmReason.formatted(),
            'midVoltage' : bmvdata.midVoltage.formattedWithUnit(),
            'topVoltage' : bmvdata.topVoltage.formattedWithUnit(),
            'current'    : bmvdata.batteryCurrent.formattedWithUnit(),
            //'soc'        : messageId,
            'soc'        : bmvdata.stateOfCharge.formatted(),
            'lowerSOC'   : socL,
            'upperSOC'   : socU,
            'timeToGo'   : bmvdata.timeToGo.formattedWithUnit()
        };
        // for testing:
        // let data = {
        //     'id' : messageId,
        //     'SOC': '100%'
        // };
        let jdata = JSON.stringify(data);
        res.write(`id: ${messageId}\n`);
        res.write(`data: ${jdata}\n\n`);
        //console.log(jdata);
        //res.write(`data: Test Message -- ${Date.now()}\n\n`);
        messageId += 1;
        //if (messageId > 100) messageId = 0;
    }

    //++clientCtr;
    //if (clientCtr > 1) return;
    
    console.log("Registering");
    vedirect.registerListener('batteryCurrent', portListener.bind(this));
    vedirect.registerListener('alarmState',     portListener.bind(this));
    vedirect.registerListener('relayState',     portListener.bind(this));
    vedirect.registerListener('alarmReason',    portListener.bind(this));
    vedirect.registerListener('midVoltage',     portListener.bind(this));
    vedirect.registerListener('topVoltage',     portListener.bind(this));
    vedirect.registerListener('stateOfCharge',  portListener.bind(this));
    vedirect.registerListener('timeToGo',       portListener.bind(this));
    
    // req.on('close', () => {
    //     //clearInterval(intervalId);
    //  // deregister and close port?
    //  if (--clientCtr === 0) {
    //      console.log("closing even source");
    //      vedirect.close();
    //  }
    // });
}

//app.use(cookieParser()); // called before!!
app.use(session({secret: "Shh, its a secret!"}));

// app.get('/', function(req, res){
//    if(req.session.page_views){
//       req.session.page_views++;
//       res.send("You visited this page " + req.session.page_views + " times");
//    } else {
//       req.session.page_views = 1;
//       res.send("Welcome to this page for the first time!");
//    }
// });

app.get('/event-stream', (req, res) => {
    // SSE Setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.write('\n');

    console.log("setting up eventstream");
    try {
	sseDemo(req.session, res);
    }
    catch(err)
    {
	//logger.debug(err);
	console.log(err);
	setTimeout(sseDemo, 120000, req.session, res);	
    }
});

var mode = 0;
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);
app.use('/users', users);

// FIXME: this error catcher messes up posting
/// catch 404 and forwarding to error handler
// app.use(function(req, res, next) {
//     var err = new Error('Not Found');
//     err.status = 404;
//     next(err);
// });

/// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

//app.listen(3001);
//console.log("Event-server running on port 3001");

// FIXME: was not there before, needed?
// serve the homepage
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});



var sunsetTimer = null;
// get the current mode (switch state):
var mode = 0;
const bmvdata = vedirect.update();
if (bmvdata.relayState.value === 'ON') mode = 1;

function toggle() {

    if (mode === 0) mode = 1
    else mode = 0;
    //console.log('switching relay to : ' + mode);

    // mode = 0 opens the BMS relay => on Mains
    vedirect.setRelay(mode, 1, true);

    clearTimeout(sunsetTimer);
}

app.post('/clicked', (req, res) => {

    toggle();

    if (mode === 1) {
	//console.log("new mode is 1: set timer to switch back");
	const now = new Date();
	//console.log("sunset is in " + solarState.getSunset());
	// approx 2 hours before sunset or before the current into 
	// the battery becomes 0
	const twoHoursTwenteeInMS = 8400000; // (2 * 60 + 20) * 60 * 1000;
	const timeTillNullChargeInMS = solarState.getSunset() * 1000 - now.getTime()
		- twoHoursTwenteeInMS;
	// FIXME: a timer will "get lost" if the server is restarted while 
	//        switched on. Better to use protection class and feed in sunset
	//        among parameters current, voltages, soc...
	// FIXME: also the timer seems not to work if set more than 24 hours in advance
	sunsetTimer = setTimeout(toggle, timeTillNullChargeInMS);
    }
    
    // if (err) {
    //   return console.log(err);
    // }
    res.sendStatus(201);
});



module.exports = app;

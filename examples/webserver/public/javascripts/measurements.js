
onload=function()
{
    const setSOC = function(soc, batteryNo) {
        if (soc === undefined || soc < 0 || soc > 100) return;
	let htmlElement = 'soc' + batteryNo;
	document.getElementById(htmlElement).innerHTML = soc.toFixed(0) + "%";
    }

    const switchDevices = function(appliances) {
	// TODO: copy from script.js once it is working
    }

    let updatePageObject = function(data) {
	// document.getElementById('Id').innerHTML = data.id;

        if (data.alarmState !== undefined)
	    document.getElementById('alarm').innerHTML = data.alarmState;
        if (data.relayState !== undefined)
	    document.getElementById('relay').innerHTML = data.relayState;
        if (data.alarmReason !== undefined)
	    //if (alarmReason in data)
	    document.getElementById('alarmReason').innerHTML = data.alarmReason;
        if (data.midVoltage !== undefined)
	    document.getElementById('midVoltage').innerHTML = data.midVoltage;
        if (data.topVoltage !== undefined)
	    document.getElementById('topVoltage').innerHTML = data.topVoltage;
	if (data.current !== undefined)
	   document.getElementById('current').innerHTML = data.current;
	if (data.timeToGo !== undefined)
	   document.getElementById('timeToGo').innerHTML = data.timeToGo;

	setSOC(data.soc, 1);
	setSOC(data.soc, 2);
    }
    
    const sseSource = new EventSource('/event-stream');
    sseSource.addEventListener('message', (e) => {
        const jdata = e.data;
        const data = JSON.parse(jdata)

	updatePageObject(data);
	// for testing:
	switchDevices({});
    });

    let initialData = {};
    initialData.alarmState = "OFF";

    updatePageObject(initialData);
    initialData.alarmState = "ON";
    //setInterval(updatePageObject(initialData), 5000);

    switchDevices({});
};

onunload=function()
{
    console.log("unload");
    sseSource.close();
}

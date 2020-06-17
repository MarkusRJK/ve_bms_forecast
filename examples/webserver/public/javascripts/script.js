var sseSource;

onload=function()
{
   const sseSource = new EventSource('/event-stream');
       sseSource.addEventListener('message', (e) => {
           const jdata = e.data;
           const data = JSON.parse(jdata)

	   // for testing:
	   // document.getElementById('Id').innerHTML = data.id;
	   // document.getElementById('SOC').innerHTML = data.SOC;

           if (data.alarmState !== undefined)
              document.getElementById('alarm').innerHTML = data.alarmState;
           if (data.relayState !== undefined)
	      document.getElementById('relay').innerHTML = data.relayState;
           if (data.relayState !== undefined)
           //if (alarmReason in data)
	      document.getElementById('alarmReason').innerHTML = data.alarmReason;
           if (data.midVoltage !== undefined)
	      document.getElementById('midVoltage').innerHTML = data.midVoltage;
           if (data.topVoltage !== undefined)
	      document.getElementById('topVoltage').innerHTML = data.topVoltage;
           if (data.current !== undefined) {
	       document.getElementById('current').innerHTML = data.current;
	       if (data.current > 10)
		   document.getElementById('bulb').src = "images/light-bulb-bw.png";
	   }
           //if (data.soc !== undefined)
	   //   document.getElementById('soc').innerHTML = data.soc;
           if (data.timeToGo !== undefined)
	      document.getElementById('timeToGo').innerHTML = data.timeToGo;
       });
};

onunload=function()
{
    console.log("unload");
    sseSource.close();
}

export const SOURCE_IDS=['codex','workbuddy','codebuddy-ide','codeg'];
export const defaultSettings=()=>({version:1,sources:Object.fromEntries(SOURCE_IDS.map(id=>[id,{enabled:true,path:''}])),monitor:{avatarStyle:'animal',railVisibleCount:8,autoDiscover:true,retentionHours:.5,assignment:'auto',seats:Array(8).fill('auto')},scene:{light:'day',weather:'clear',lightning:true,door:false,ceiling:false,playing:true,speed:1,maxFps:60,renderResolution:'native',showPerformance:false,reducedMotion:false,defaultView:'program'},notifications:{desktop:false,wait:true,error:true,done:true,sound:false},general:{mode:'live',rememberView:true},schedule:{enabled:false,start:'09:00',end:'18:00',deferBusy:true}});
export function validateSettings(input){
 const d=defaultSettings();if(!input||input.version!==1)throw Error('配置版本无效');
 for(const id of SOURCE_IDS){const s=input.sources?.[id];if(!s||typeof s.enabled!=='boolean'||typeof s.path!=='string'||s.path.length>2048||s.path.includes('\0'))throw Error('Agent 配置无效');d.sources[id]={enabled:s.enabled,path:s.path.trim()};}
 for(const group of ['monitor','scene','notifications','general','schedule']){if(!input[group])throw Error('缺少配置分组');for(const k of Object.keys(d[group])){const value=group==='monitor'&&['railVisibleCount','avatarStyle'].includes(k)&&input[group][k]===undefined?d[group][k]:group==='scene'&&['maxFps','renderResolution','showPerformance','weather','lightning'].includes(k)&&input[group][k]===undefined?d[group][k]:input[group][k];if(typeof d[group][k]==='boolean'&&typeof value!=='boolean')throw Error('开关配置无效');d[group][k]=value;}}
 const choices=(v,values)=>{if(!values.includes(v))throw Error('配置选项无效');};
 choices(d.monitor.avatarStyle,['animal','bot']);
 choices(d.monitor.railVisibleCount,[3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
 choices(d.monitor.retentionHours,[0,.5,24,168]);choices(d.monitor.assignment,['auto','fixed']);if(!Array.isArray(d.monitor.seats)||d.monitor.seats.length!==8||d.monitor.seats.some(s=>!['auto',...SOURCE_IDS].includes(s)))throw Error('工位配置无效');
 choices(d.scene.light,['day','night','auto']);choices(d.scene.weather,['clear','overcast','rain','downpour','thunderstorm','wind','auto']);choices(d.scene.speed,[1,2,4]);choices(d.scene.maxFps,[30,60]);choices(d.scene.renderResolution,['native','balanced','low']);choices(d.scene.defaultView,['all','program','device']);choices(d.general.mode,['live','demo']);
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.schedule.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.schedule.end)||d.schedule.start>=d.schedule.end)throw Error('上班时间必须早于下班时间');
 return d;
}

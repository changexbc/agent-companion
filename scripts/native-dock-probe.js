// Opt-in self-test of this application's own WebView, including its native IPC.
void (async () => {
  const report=window.__companionDockQA={checks:[],variants:[],passed:false};
  const check=(name,condition)=>{report.checks.push({name,passed:!!condition});if(!condition)throw Error(name);};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const bridge=window.__TAURI_INTERNALS__;
  const invoke=bridge.invoke.bind(bridge);
  const emit=(event,payload)=>invoke('plugin:event|emit',{event,payload});
  const savedPreferences=await invoke('plugin:agent-studio|rail_settings_get');
  // The isolated QA process uses deterministic temporary preferences; it never
  // writes the user's settings file. All temporary state disappears on exit.
  const preferences={...savedPreferences,avatarStyle:'cinema',visibleCount:8,size:'small',animation:true};
  const rows=()=>[...document.querySelectorAll('.desktop-list>.desktop-avatar')].filter(element=>!element.hidden);
  const visual=element=>element.querySelector('.desktop-avatar-visual')??element;
  const scale=element=>visual(element).getBoundingClientRect().width/parseFloat(getComputedStyle(element).width);
  const center=element=>{const rect=element.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};};
  const face=element=>{
    const copy=element.querySelector('.desktop-portrait').cloneNode(true);
    // Gaze follows the mouse using an existing inline transform. Preserve all
    // artwork and expression paths, while allowing that intended motion.
    copy.querySelectorAll('.companion-pointer').forEach(group=>group.removeAttribute('style'));
    return copy.innerHTML;
  };
  const contained=element=>{
    const rect=visual(element).getBoundingClientRect(),bounds=element.parentElement.getBoundingClientRect();
    return rect.left>=bounds.left-.5 && rect.right<=bounds.right+.5 && rect.top>=bounds.top-.5 && rect.bottom<=bounds.bottom+.5;
  };
  try {
    await emit('agent-studio-rail-settings',preferences);await delay(380);
    check('fixture has neighbors',rows().length>=3);
    check('actual drawing dimensions support magnification',CSS.supports('width','calc(44px * 1.4)'));
    check('motion is available for this fixture',!matchMedia('(prefers-reduced-motion: reduce)').matches && preferences.animation);
    await emit('agent-studio-pointer',null);await delay(380);
    const initial=rows().map(element=>element.offsetTop);
    const initialDrawWidth=parseFloat(getComputedStyle(rows()[1].querySelector('.desktop-portrait')).width);
    const initialFace=face(rows()[1]);
    const point=center(rows()[1]);
    await emit('agent-studio-pointer',point);await delay(380);
    report.focused=rows().map(element=>({scale:scale(element),width:visual(element).getBoundingClientRect().width}));
    const enlargedDrawWidth=parseFloat(getComputedStyle(rows()[1].querySelector('.desktop-portrait')).width);
    report.drawSizes={before:initialDrawWidth,after:enlargedDrawWidth,pixelRatio:devicePixelRatio};
    check('enlargement redraws the portrait at its larger layout resolution',enlargedDrawWidth>initialDrawWidth*1.38);
    check('enlargement preserves the original face and expression',face(rows()[1])===initialFace);
    check('only the round visual surface paints the avatar background',getComputedStyle(rows()[1]).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(visual(rows()[1])).borderRadius==='50%');
    check('native pointer enlarges nearest avatar',scale(rows()[1])>1.38 && scale(rows()[1])<=1.401);
    check('native pointer gently enlarges both neighbors',scale(rows()[0])>1.05 && scale(rows()[2])>1.05);
    check('enlargement leaves layout anchors stable',rows().every((element,index)=>element.offsetTop===initial[index]));
    check('enlarged portraits fit the scroll viewport',rows().slice(0,3).every(contained));
    const button=rows()[1],edge={x:point.x+button.offsetWidth/2+2,y:point.y};
    check('enlarged outer edge reaches the correct button',document.elementFromPoint(edge.x,edge.y)?.closest('.desktop-avatar')===button);
    await emit('agent-studio-pointer',null);await delay(380);
    check('leaving restores every avatar',rows().every(element=>Math.abs(scale(element)-1)<.002));
    // All style/size changes go through the real preferences listener; no file is saved.
    for(const style of ['animal','bot','critters','cinema'])for(const size of ['small','medium','standard']){
      await emit('agent-studio-rail-settings',{...preferences,avatarStyle:style,size});
      // Resizing also runs the existing 300ms FLIP reorder animation. Measure
      // the final layout rather than aiming at an avatar still in transit.
      await delay(380);
      await emit('agent-studio-pointer',center(rows()[1]));await delay(380);
      report.variants.push({style,size,scale:scale(rows()[1]),contained:contained(rows()[1])});
      check(style+' '+size+' magnification',scale(rows()[1])>1.38 && contained(rows()[1]));
      await emit('agent-studio-pointer',null);
    }
    await emit('agent-studio-rail-settings',{...preferences,animation:false});
    await emit('agent-studio-pointer',center(rows()[1]));await delay(80);
    check('animation switch disables the lens',rows().every(element=>Math.abs(scale(element)-1)<.002));
    await emit('agent-studio-rail-settings',preferences);await delay(80);
    const overflow=document.querySelector('.desktop-overflow');
    if(overflow && !overflow.hidden){overflow.click();await delay(380);}
    const list=document.querySelector('.desktop-list');
    if(list.scrollHeight>list.clientHeight){
      list.scrollTop=48;list.dispatchEvent(new Event('scroll'));await delay(40);
      const anchor=rows().find(element=>{const r=element.getBoundingClientRect(),b=list.getBoundingClientRect();return r.top>b.top+20 && r.bottom<b.bottom-20;});
      await emit('agent-studio-pointer',center(anchor));await delay(380);
      check('scroll keeps the lens centered and unclipped',scale(anchor)>1.38 && contained(anchor));
      list.scrollTop=0;list.dispatchEvent(new Event('scroll'));
      if(overflow?.getAttribute('aria-expanded')==='true'){overflow.click();await delay(380);}
    }
    await emit('agent-studio-pointer',null);await delay(380);
    // The browser pointer path also works in the demo / foreground WebView.
    const finalPoint=center(rows()[1]);
    document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:finalPoint.x,clientY:finalPoint.y}));
    await delay(380);
    check('DOM mouse movement also drives the lens',scale(rows()[1])>1.38);
    report.finalEdge={x:finalPoint.x+rows()[1].offsetWidth/2+2,y:finalPoint.y};
    report.passed=true;
  } catch(error) {report.error=String(error);}

})();

(function(){
  var v=document.getElementById('v'), idle=document.getElementById('idle'),
      status=document.getElementById('status'), tap=document.getElementById('tap');
  var wsPort=window.WS_PORT||0, ws=null, hls=null, pendingStart=0, playAttempt=0;
  var engine=null, currentMedia=null, wantedAudio=null, wantedSubtitle=-1;
  var nativeHls=false, nativeGeneration=0, nativeApplyTimer=null, nativeApplyAttempts=0;
  var nativeRenditions={audio:[],subtitle:[]};
  var SENDER=window.SENDER||'the sender';
  /* Remote (WebRTC) mode. The same page serves both transports: with a room
     it answers the sender over a data channel instead of taking commands from
     the LAN control socket. ES5 query parsing on purpose — URLSearchParams is
     Chrome 49+ and would throw on the TV before anything ran. */
  function queryParam(name){
    var source=String(location.search||'')+'&'+String(location.hash||'').replace(/^#/,'');
    var match=new RegExp('(?:[?&#]|^)'+name+'=([^&#]*)').exec(source);
    return match?decodeURIComponent(match[1].replace(/\+/g,' ')):'';
  }
  var RTC_ROOM=window.RTC_ROOM||queryParam('room')||queryParam('code');
  var RTC_SIG=queryParam('sig')||window.RTC_SIG||'https://plexcast-signal.rikard-wissing.workers.dev';
  var rtcMode=!!RTC_ROOM, rtc=null, rtcGen=null;
  // Old TV browsers (webOS/Tizen) have no devtools — surface script
  // failures and connection state in the status line itself, so a
  // stuck screen names its cause instead of sitting at "Connecting".
  window.onerror=function(msg,src,line){
    try{
      idle.classList.remove('hidden');
      status.textContent='Script error: '+msg+' ('+String(src||'').split('/').pop()+':'+line+')';
    }catch(e){}
  };
  function show(el){ idle.classList.add('hidden'); v.classList.add('hidden'); el.classList.remove('hidden'); }
  function connect(){
    try{ ws=new WebSocket('ws://'+location.hostname+':'+wsPort); }
    catch(err){
      status.textContent='WebSocket failed: '+(err&&err.message||err)+' — retrying…';
      setTimeout(connect,3000); return;
    }
    var opened=false;
    ws.onopen=function(){
      opened=true;
      if(!rtcMode) status.textContent='Connected — waiting for '+SENDER+' to start a video';
      send({type:'ready'});
      trace('viewer ua: '+navigator.userAgent); reportRtcCaps();
    };
    ws.onclose=function(){ if(!rtcMode) status.textContent='Lost '+SENDER+' — reconnecting…'; setTimeout(connect,2000); };
    ws.onerror=function(){ try{ws.close()}catch(e){} };
    /* In remote mode this socket exists only to carry traces home (the page is
       still served by the app, so the log pipe works); the sender drives
       playback over the data channel and its LAN commands must not race it. */
    ws.onmessage=function(e){ if(rtcMode) return; handle(JSON.parse(e.data)); };
    setTimeout(function(){
      if(!opened&&ws&&ws.readyState!==1&&!rtcMode){
        status.textContent='Can\'t reach '+SENDER+' on port '+wsPort+' (state '+ws.readyState+') — check that both devices share the network; retrying…';
      }
    },4000);
  }
  function send(o){
    if(rtcMode){
      if(!rtc) return;
      if(o&&o.type==='status'){
        rtc.send({t:'status',gen:rtcGen,position:o.position||0,duration:o.duration||0,
                  paused:!!o.paused,ended:!!o.ended});
      }
      return;
    }
    if(ws&&ws.readyState===1) ws.send(JSON.stringify(o));
  }
  /* Remote mode: the sender's control messages use single-letter keys over the
     data channel ({t:"load"}); the LAN sender uses {type:"load"}. Translate so
     one handle() drives both transports. */
  function startRtc(){
    if(typeof PlexRtc==='undefined'){
      status.textContent='This TV browser can’t run remote casting.';
      trace('rtc: PlexRtc missing (script failed to load or parse)');
      return;
    }
    status.textContent='Connecting to '+SENDER+'…';
    rtc=new PlexRtc(RTC_ROOM,RTC_SIG,{
      onState:function(text){ if(text) status.textContent=text; },
      onOpen:function(){ status.textContent='Connected — waiting for '+SENDER+' to start a video'; },
      onClose:function(){ status.textContent='Lost '+SENDER+' — waiting for it to come back…'; },
      onFatal:function(reason){ status.textContent='Remote casting is unavailable on this TV ('+reason+').'; },
      onControl:function(obj){
        if(obj.t==='hi'){
          if(obj.sender){ SENDER=String(obj.sender).slice(0,40); status.textContent='Connected — waiting for '+SENDER+' to start a video'; }
          return;
        }
        if(obj.t==='pair'||obj.t==='subs') return;           // pairing/sidecars: LAN path only for now
        if(obj.t==='load'){ rtcGen=(obj.gen!=null?obj.gen:null); }
        var mapped={},key;
        for(key in obj) if(Object.prototype.hasOwnProperty.call(obj,key)) mapped[key]=obj[key];
        mapped.type=obj.t;
        handle(mapped);
      }
    });
    rtc.start();
  }
  /* One-shot WebRTC capability report. Old TV browsers expose wildly
     different RTC surfaces (callback-only APIs, addStream instead of
     addTrack, no srcObject) and have no devtools, so the receiver reports
     what it has through the trace pipe. Property probes only — nothing is
     negotiated, nothing is offered, no media is touched. */
  var capsReported=false;
  function reportRtcCaps(){
    if(capsReported) return; capsReported=true;
    var out=[];
    try{
      var Ctor=window.RTCPeerConnection||window.webkitRTCPeerConnection||window.mozRTCPeerConnection||null;
      out.push('pc='+(window.RTCPeerConnection?'std':(window.webkitRTCPeerConnection?'webkit':(window.mozRTCPeerConnection?'moz':'none'))));
      out.push('srcObject='+(('srcObject' in document.createElement('video'))?'yes':'no'));
      out.push('sdesc='+((window.RTCSessionDescription||window.webkitRTCSessionDescription)?'yes':'no'));
      out.push('icecand='+((window.RTCIceCandidate||window.webkitRTCIceCandidate)?'yes':'no'));
      if(Ctor){
        var pc=null;
        try{ pc=new Ctor({iceServers:[]}); }catch(eCtor){ out.push('ctorThrew='+eCtor); }
        if(pc){
          out.push('addTrack='+(typeof pc.addTrack==='function'?'yes':'no'));
          out.push('ontrack='+(('ontrack' in pc)?'yes':'no'));
          out.push('addStream='+(typeof pc.addStream==='function'?'yes':'no'));
          out.push('onaddstream='+(('onaddstream' in pc)?'yes':'no'));
          out.push('createDC='+(typeof pc.createDataChannel==='function'?'yes':'no'));
          var promised=false;
          try{
            var r=pc.createOffer();
            if(r&&typeof r.then==='function'){ promised=true; r.then(function(){},function(){}); }
          }catch(eOffer){}
          out.push('promiseApi='+(promised?'yes':'no'));
          try{
            var dc=pc.createDataChannel('caps');
            out.push('dcBinary='+(dc&&dc.binaryType?dc.binaryType:'?'));
            try{dc.close()}catch(eClose){}
          }catch(eDC){ out.push('dcThrew='+eDC); }
          try{pc.close()}catch(ePc){}
        }
      }
    }catch(e){ out.push('probe threw: '+e); }
    trace('tv rtc caps: '+out.join(' '));
  }
  function autoplayRejected(generation,error){
    if(generation!==playAttempt) return;
    // An unmuted autoplay may be forbidden by browser/site policy. Only
    // ask for a gesture when the browser actually says it needs one;
    // codec/network/abort failures are not fixed by a tap.
    if(error&&error.name==='NotAllowedError') tap.classList.remove('hidden');
  }
  function tryPlay(){
    var generation=++playAttempt, result;
    tap.classList.add('hidden');
    try{ result=v.play(); }
    catch(error){ autoplayRejected(generation,error); return; }
    if(result&&result.catch) result.catch(function(error){autoplayRejected(generation,error)});
  }
  function handle(m){
    if(m.type==='load'){
      load(m);
    } else if(m.type==='play'){ tryPlay(); }
    else if(m.type==='pause'){ v.pause(); }
    else if(m.type==='seek'){ v.currentTime=m.time; }
    else if(m.type==='volume'){ v.volume=m.value; }
    else if(m.type==='stop'){ stopMedia(); }
    // Sender picked an audio/subtitle track by its app typeIndex. Package
    // renditions are named audio<N>.m3u8 / sub<N>.m3u8, so match by URL
    // rather than manifest position. A direct MP4 routes to MSE/<track>;
    // Safari HLS routes to WebKit's native AudioTrack/TextTrack lists.
    else if(m.type==='audioTrack'&&m.typeIndex!=null){
      wantedAudio=parseInt(m.typeIndex,10);
      if(currentMedia) currentMedia.audioTypeIndex=wantedAudio;
      if(hls){ applyHlsTracks(); }
      else if(nativeHls){ nativeApplyAttempts=0; requestNativeHlsApply(); }
      else if(engine){ try{engine.setAudioTrack(m.typeIndex)}catch(e){} }
      else { applyNativeAudioTrack(); }
    }
    else if(m.type==='subtitleTrack'&&m.typeIndex!=null){
      wantedSubtitle=parseInt(m.typeIndex,10);
      if(currentMedia) currentMedia.subtitleTypeIndex=wantedSubtitle;
      if(hls){ applyHlsTracks(); }
      else if(nativeHls){ nativeApplyAttempts=0; requestNativeHlsApply(); }
      else { selectSubtitle(wantedSubtitle); }
    }
  }
  // Match the hls.js audio/subtitle track whose rendition encodes the app
  // typeIndex (audio<N>.m3u8 / sub<N>.m3u8); digit boundary so 1!=12.
  function renditionIndex(tracks,kind,typeIndex){
    tracks=tracks||[]; var re=new RegExp(kind+typeIndex+'(?![0-9])');
    for(var i=0;i<tracks.length;i++){ var t=tracks[i]||{}; var u=t.url||(t.attrs&&t.attrs.URI)||t.name||''; if(re.test(String(u))) return i; }
    return -1;
  }
  function applyHlsTracks(){
    if(!hls) return;
    if(wantedAudio!=null){
      var ai=renditionIndex(hls.audioTracks,'audio',wantedAudio);
      if(ai>=0){ try{hls.audioTrack=ai}catch(e){} }
    }
    if(wantedSubtitle<0){ try{hls.subtitleDisplay=false; hls.subtitleTrack=-1}catch(e){} }
    else {
      var si=renditionIndex(hls.subtitleTracks,'sub',wantedSubtitle);
      if(si>=0){ try{hls.subtitleDisplay=true; hls.subtitleTrack=si}catch(e){} }
    }
  }
  function destroyHls(){ if(hls){ try{hls.destroy()}catch(e){} hls=null; } }
  function ensureHls(cb){
    if(window.Hls){ cb(); return; }
    var s=document.createElement('script'); s.src='/hls.js';
    s.onload=function(){ cb(); }; s.onerror=function(){ cb(new Error('no hls.js')); };
    document.head.appendChild(s);
  }
  // Plain <video src> path (no engine, no hls.js — 2017-era TVs): switch
  // between the MP4's muxed audio tracks with the native AudioTrackList.
  // Muxed order == ffmpeg 0:a:N == the app's typeIndex.
  function applyNativeAudioTrack(){
    if(wantedAudio==null||hls||nativeHls||engine) return;
    if(!v.audioTracks||!v.audioTracks.length){
      trace('native audio switch: no AudioTrackList on this browser');
      return;
    }
    if(wantedAudio>=v.audioTracks.length){
      trace('native audio switch: track #'+wantedAudio+' of '+v.audioTracks.length+' unavailable');
      return;
    }
    for(var i=0;i<v.audioTracks.length;i++) v.audioTracks[i].enabled=(i===wantedAudio);
    trace('native audio → #'+wantedAudio+' (muxed)');
  }
  function nativeHlsPlayable(){
    return !!v.canPlayType('application/vnd.apple.mpegurl');
  }
  function nativeHlsControllable(){
    // Chromium can report native HLS playback without exposing the
    // AudioTrackList API needed to switch renditions. Safari exposes
    // it, so native HLS remains the best path there.
    return nativeHlsPlayable()&&!!v.audioTracks&&typeof v.audioTracks.addEventListener==='function';
  }
  function playNativeHls(m){
    trace('HLS engine: native');
    beginNativeHls(m.url); v.src=m.url; tryPlay();
    // 2017-era TVs report native HLS support but can only demux MPEG-TS
    // segments — our packages are fMP4, so "supported" playback produces
    // nothing. If no data arrives, hand the same manifest to hls.js,
    // which feeds fMP4 through MSE instead.
    var generation=nativeGeneration;
    setTimeout(function(){
      if(!nativeHls||generation!==nativeGeneration) return;
      if(v.readyState>=2) return;
      trace('native HLS produced nothing (readyState '+v.readyState+') — falling back to hls.js');
      clearNativeHls();
      playJavascriptHls(m,true);
    },8000);
  }
  function playJavascriptHls(m,noNativeFallback){
    ensureHls(function(err){
      if(!err&&window.Hls&&window.Hls.isSupported()){
        trace('HLS engine: hls.js');
        hls=new window.Hls();
        hls.on(window.Hls.Events.ERROR,function(evt,data){
          if(!data||!data.fatal) return;
          trace('hls fatal: '+data.type+'/'+data.details);
          if(data.type==='mediaError'&&!hls.__recovered){
            hls.__recovered=true;
            try{hls.recoverMediaError();return}catch(e){}
          }
          playbackError('HLS playback failed ('+data.details+')');
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function(){
          applyHlsTracks();
          if(pendingStart>0){ v.currentTime=pendingStart; pendingStart=0; }
          tryPlay();
        });
        if(window.Hls.Events.AUDIO_TRACKS_UPDATED) hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED,applyHlsTracks);
        if(window.Hls.Events.SUBTITLE_TRACKS_UPDATED) hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED,applyHlsTracks);
        hls.loadSource(m.url); hls.attachMedia(v);
        return;
      }
      trace('hls.js unusable: err='+(err||'none')+' lib='+(typeof window.Hls)
        +' supported='+(window.Hls&&window.Hls.isSupported&&window.Hls.isSupported())
        +' native="'+v.canPlayType('application/vnd.apple.mpegurl')+'"');
      // iOS/WebKit may support native HLS without MSE/hls.js. Keep
      // playback working even if that browser offers no scriptable
      // alternate-track API.
      if(nativeHlsPlayable()&&!noNativeFallback){ playNativeHls(m); return; }
      show(idle); status.textContent='This browser can’t play this format';
    });
  }

  // ---- Native HLS tracks (Safari/WebKit) ---------------------------
  // WebKit exposes HLS renditions through HTMLMediaElement.audioTracks
  // and textTracks, but often only after metadata arrives. Parse the
  // master now for stable app typeIndexes, then keep retrying a pending
  // choice as WebKit materialises those native track objects.
  function hlsAttributes(line){
    var out={}, re=/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, match;
    while((match=re.exec(line))){
      var value=match[2]||'';
      if(value.length>=2&&value.charAt(0)==='"'&&value.charAt(value.length-1)==='"') value=value.slice(1,-1);
      out[match[1]]=value;
    }
    return out;
  }
  function manifestTypeIndex(kind,uri){
    var match=new RegExp(kind+'([0-9]+)(?:p)?[.]m3u8(?:$|[?#])','i').exec(String(uri||''));
    return match?parseInt(match[1],10):null;
  }
  function parseNativeRenditions(master){
    var result={audio:[],subtitle:[]}, seen={audio:{},subtitle:{}};
    String(master||'').split(/\r?\n/).forEach(function(line){
      if(line.indexOf('#EXT-X-MEDIA:')!==0) return;
      var attrs=hlsAttributes(line), kind=attrs.TYPE==='AUDIO'?'audio':attrs.TYPE==='SUBTITLES'?'subtitle':null;
      if(!kind) return;
      var typeIndex=manifestTypeIndex(kind==='subtitle'?'sub':'audio',attrs.URI);
      if(typeIndex==null||seen[kind][typeIndex]) return;
      seen[kind][typeIndex]=true;
      result[kind].push({typeIndex:typeIndex,uri:attrs.URI||'',name:attrs.NAME||'',language:attrs.LANGUAGE||''});
    });
    return result;
  }
  function nativeListItems(list,textOnly){
    var out=[];
    if(!list) return out;
    for(var i=0;i<list.length;i++){
      var track=list.item?list.item(i):list[i]; if(!track) continue;
      var kind=String(track.kind||'').toLowerCase();
      if(textOnly&&kind&&kind!=='subtitles'&&kind!=='captions') continue;
      out.push({track:track,listIndex:i});
    }
    return out;
  }
  function normalLanguage(value){ return String(value||'').toLowerCase().replace('_','-'); }
  function nativeTrackPosition(items,renditions,typeIndex,kind){
    var target=null, ordinal=-1;
    for(var r=0;r<renditions.length;r++) if(renditions[r].typeIndex===typeIndex){target=renditions[r];ordinal=r;break;}
    if(!target) return -1;
    var direct=new RegExp((kind==='subtitle'?'sub':'audio')+typeIndex+'(?![0-9])','i');
    for(var i=0;i<items.length;i++){
      var t=items[i].track, identity=[t.id,t.label,t.name].join(' ');
      if(direct.test(identity)) return i;
    }
    var best=-1,bestScore=0, wantedLanguage=normalLanguage(target.language), wantedName=String(target.name||'').toLowerCase();
    for(var j=0;j<items.length;j++){
      var candidate=items[j].track, score=0;
      var language=normalLanguage(candidate.language), name=String(candidate.label||candidate.name||'').toLowerCase();
      if(wantedLanguage&&language){
        if(language===wantedLanguage) score+=8;
        else if(language.split('-')[0]===wantedLanguage.split('-')[0]) score+=4;
      }
      if(wantedName&&name){ if(name===wantedName) score+=6; else if(name.indexOf(wantedName)>=0||wantedName.indexOf(name)>=0) score+=2; }
      if(score>bestScore){bestScore=score;best=j;}
    }
    if(best>=0) return best;
    return ordinal<items.length?ordinal:-1;
  }
  function applyNativeHlsTracks(){
    if(!nativeHls) return true;
    var audioDone=wantedAudio==null, subtitleDone=false;
    if(wantedAudio!=null){
      var audio=nativeListItems(v.audioTracks,false);
      var audioPosition=nativeTrackPosition(audio,nativeRenditions.audio,wantedAudio,'audio');
      if(audioPosition>=0){
        for(var a=0;a<audio.length;a++) try{audio[a].track.enabled=a===audioPosition}catch(e){}
        audioDone=true;
      }
    }
    var text=nativeListItems(v.textTracks,true);
    if(wantedSubtitle<0){
      for(var s=0;s<text.length;s++) try{text[s].track.mode='disabled'}catch(e){}
      subtitleDone=true;
    } else {
      var subtitlePosition=nativeTrackPosition(text,nativeRenditions.subtitle,wantedSubtitle,'subtitle');
      if(subtitlePosition>=0){
        for(var t=0;t<text.length;t++) try{text[t].track.mode=t===subtitlePosition?'showing':'disabled'}catch(e){}
        subtitleDone=true;
      }
    }
    return audioDone&&subtitleDone;
  }
  function requestNativeHlsApply(){
    if(nativeApplyTimer){clearTimeout(nativeApplyTimer);nativeApplyTimer=null;}
    if(!nativeHls||applyNativeHlsTracks()||nativeApplyAttempts>=20) return;
    nativeApplyAttempts++;
    nativeApplyTimer=setTimeout(requestNativeHlsApply,Math.min(1000,100+nativeApplyAttempts*100));
  }
  function beginNativeHls(url){
    nativeHls=true; nativeApplyAttempts=0; var generation=++nativeGeneration;
    nativeRenditions={audio:[],subtitle:[]};
    // XHR, not fetch — the rendition map must work on 2017-era TV
    // engines too, or sender-driven track switching dies with them.
    try{
      var xhr=new XMLHttpRequest();
      xhr.open('GET',url,true);
      xhr.onload=function(){
        if(!nativeHls||generation!==nativeGeneration) return;
        var master=(xhr.status>=200&&xhr.status<300)?String(xhr.responseText||''):'';
        nativeRenditions=parseNativeRenditions(master); nativeApplyAttempts=0; requestNativeHlsApply();
      };
      xhr.onerror=function(){ trace('native HLS manifest map failed'); };
      xhr.send();
    }catch(e){ trace('native HLS manifest map failed: '+e); }
    requestNativeHlsApply();
  }
  function clearNativeHls(){
    nativeHls=false; nativeGeneration++; nativeRenditions={audio:[],subtitle:[]}; nativeApplyAttempts=0;
    if(nativeApplyTimer){clearTimeout(nativeApplyTimer);nativeApplyTimer=null;}
  }
  function nativeTracksChanged(){ if(nativeHls){nativeApplyAttempts=0;requestNativeHlsApply();} }
  if(v.audioTracks&&v.audioTracks.addEventListener) v.audioTracks.addEventListener('addtrack',nativeTracksChanged);
  if(v.textTracks&&v.textTracks.addEventListener) v.textTracks.addEventListener('addtrack',nativeTracksChanged);

  /* Three sinks, because a TV has no devtools and the hosted copy of this page
     has no LAN socket: the console (harness), the LAN trace pipe (app log), and
     the data channel (remote sessions land in the app log the same way). In
     remote mode the last few lines are also drawn on the TV itself, so a stuck
     screen names its own cause without anyone reading a log. */
  function trace(message){
    try{console.log('plexcast:',message)}catch(e){}
    try{ if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'trace',message:String(message)})); }catch(e){}
    try{ if(rtcMode&&rtc) rtc.send({t:'trace',message:String(message)}); }catch(e2){}
    if(rtcMode) showDebug(String(message));
  }
  var debugBox=null, debugLines=[];
  function showDebug(line){
    debugLines.push(line);
    if(debugLines.length>9) debugLines.shift();
    try{
      if(!debugBox){
        debugBox=document.createElement('div');
        debugBox.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:20;'+
          'background:rgba(0,0,0,.72);color:#9aa3b5;font:12px monospace;'+
          'padding:8px 10px;white-space:pre-wrap;text-align:left;max-height:40%;overflow:hidden';
        document.body.appendChild(debugBox);
      }
      debugBox.textContent=debugLines.join('\n');
    }catch(e){}
  }
  // The tripwire (page errors) and the isolated engine report through this.
  window.tvReport=trace;
  function teardownEngine(){ if(engine){ try{engine.destroy()}catch(e){} engine=null; } }
  function resetMedia(){
    playAttempt++; tap.classList.add('hidden');
    destroyHls(); clearNativeHls(); teardownEngine(); clearSubtitles();
    try{v.pause()}catch(e){} v.removeAttribute('src'); try{v.load()}catch(e){}
  }
  function stopMedia(){ currentMedia=null; resetMedia(); show(idle); status.textContent='Choose something to play in '+SENDER; }
  function playbackError(detail){
    resetMedia(); show(idle); status.textContent=detail;
    send({type:'error',reason:detail});
  }
  function codecName(c){
    c=String(c||'').toLowerCase();
    if(c.indexOf('ec-3')===0) return 'E-AC-3 (Dolby Digital Plus)';
    if(c.indexOf('ac-3')===0) return 'AC-3 (Dolby Digital)';
    if(c.indexOf('dts')===0) return 'DTS';
    if(c.indexOf('mlp')===0||c.indexOf('truehd')>=0) return 'TrueHD';
    if(c.indexOf('hev')===0||c.indexOf('hvc')===0) return 'HEVC';
    if(c.indexOf('av01')===0) return 'AV1';
    return c;
  }
  function canPlay(kind,codec){
    if(!codec) return true;
    try{ return window.MediaSource
      ? MediaSource.isTypeSupported(kind+'/mp4; codecs="'+codec+'"')
      : v.canPlayType(kind+'/mp4; codecs="'+codec+'"')!==''; }
    catch(e){ return true; }
  }
  // The isolated MSE engine (tv-mse.js) borrows these via window.
  window.tvHelpers={canPlay:canPlay,codecName:codecName,playbackError:playbackError};

  // ---- Direct-file subtitle overlays --------------------------------
  var applyingSubs=false, applyTimer=null, enforcingSubs=false, directSubsActive=false;
  function beginSubMutation(){
    applyingSubs=true;
    if(applyTimer) clearTimeout(applyTimer);
    applyTimer=setTimeout(function(){applyingSubs=false},400);
  }
  function trackMode(el){
    var ti=parseInt(el.getAttribute('data-typeindex'),10);
    return wantedSubtitle>=0&&ti===wantedSubtitle?'showing':'disabled';
  }
  function clearSubtitles(){
    beginSubMutation(); directSubsActive=false;
    var tracks=v.querySelectorAll('track');
    for(var i=0;i<tracks.length;i++) v.removeChild(tracks[i]);
  }
  function enforceSingleSubtitle(){
    if(enforcingSubs||!directSubsActive) return;
    enforcingSubs=true;
    var tracks=v.querySelectorAll('track');
    for(var i=0;i<tracks.length;i++){
      var mode=trackMode(tracks[i]);
      try{if(tracks[i].track.mode!==mode) tracks[i].track.mode=mode}catch(e){}
    }
    enforcingSubs=false;
  }
  function applySubtitles(list){
    clearSubtitles();
    if(!list||!list.length) return;
    directSubsActive=true;
    list.forEach(function(s,i){
      var t=document.createElement('track');
      t.kind='subtitles'; t.src=s.url; t.srclang=s.lang||('s'+i);
      t.label=s.label||('Track '+(i+1));
      t.setAttribute('data-typeindex',String(s.typeIndex!=null?s.typeIndex:i));
      t.addEventListener('load',function(){beginSubMutation(); enforceSingleSubtitle()});
      v.appendChild(t);
      try{t.track.mode=trackMode(t)}catch(e){}
    });
  }
  function selectSubtitle(typeIndex){
    if(!directSubsActive) return;
    beginSubMutation(); wantedSubtitle=typeIndex==null?-1:typeIndex;
    if(currentMedia) currentMedia.subtitleTypeIndex=wantedSubtitle;
    enforceSingleSubtitle();
  }
  if(v.textTracks){
    v.textTracks.addEventListener('change',function(){
      // Safari's native-HLS tracks are not our sidecars. Never interpret
      // those as a direct-file CC-menu pick.
      if(hls||!directSubsActive||enforcingSubs) return;
      if(applyingSubs){enforceSingleSubtitle();return;}
      var showing=[], tracks=v.querySelectorAll('track');
      for(var i=0;i<tracks.length;i++) if(tracks[i].track.mode==='showing')
        showing.push(parseInt(tracks[i].getAttribute('data-typeindex'),10));
      var ok=wantedSubtitle<0?showing.length===0:
        showing.length===1&&showing[0]===wantedSubtitle;
      if(ok) return;
      var pick=-1;
      for(var j=0;j<showing.length;j++) if(showing[j]!==wantedSubtitle){pick=showing[j];break;}
      wantedSubtitle=pick;
      if(currentMedia) currentMedia.subtitleTypeIndex=pick;
      enforceSingleSubtitle();
      send({type:'pickSubtitle',typeIndex:pick});
    });
  }

  // ---- MSE engine: switch audio in a multi-audio direct MP4 ----------
  // Keep the engine logic in sync with docs/rtc/index.html. The only
  // transport difference is fetch(Range) here versus the WebRTC channel.
  v.addEventListener('seeking',function(){if(engine)engine.reposition(v.currentTime||0)});

  function load(m){
    resetMedia(); currentMedia=m;
    wantedAudio=m.audioTypeIndex!=null?parseInt(m.audioTypeIndex,10):null;
    wantedSubtitle=m.subtitleTypeIndex!=null?m.subtitleTypeIndex:-1;
    // Remote paths (poster included) are virtual — only the data channel can
    // resolve them, so don't hand them to the element as URLs.
    if(m.poster&&!rtcMode) v.poster=m.poster;
    pendingStart=m.startTime||0;
    show(v);
    var isHls=/\.m3u8($|\?)/i.test(m.url||'');
    // A package carries its own audio/subtitles in the manifest, so
    // no sidecar <track>s for HLS. Safari has controllable native HLS;
    // Chromium variants that only report playback support use hls.js.
    if(isHls){
      if(rtcMode){
        // hls.js would need a data-channel loader plugin to fetch fragments;
        // until then, remote casting to the TV covers direct files only.
        show(idle);
        status.textContent='HLS packages can’t be cast to this TV remotely yet — play the file itself.';
        trace('rtc: refused HLS package (no data-channel loader yet)');
        return;
      }
      if(nativeHlsControllable()) playNativeHls(m);
      else playJavascriptHls(m);
      return;
    }
    /* Remote mode has no HTTP media URL at all — m.url is a virtual path the
       sender resolves over the data channel — so the engine is the only way to
       play, and there is no plain <video src> to fall back to. */
    var useEngine=(m.mse||rtcMode)&&window.MediaSource&&typeof MP4Box!=='undefined'&&typeof MseEngine!=='undefined';
    if(useEngine){
      engine=new MseEngine(m.url,m.audioTypeIndex||0,rtcMode?rtc.fetcher():null);
      v.src=engine.objectUrl;
      // An engine fatal (e.g. mp4box's parse bug on some TVs) falls back
      // to plain playback at the live position — native muxed audio
      // switching still applies there via applyNativeAudioTrack.
      engine.onEngineFailed=function(reason){
        if(rtcMode){
          show(idle);
          status.textContent='Couldn’t play this video on the TV.';
          trace('rtc: engine failed with no fallback available: '+reason);
          return;
        }
        var at=v.currentTime||m.startTime||0;
        var next={}; for(var key in currentMedia||m)next[key]=(currentMedia||m)[key];
        next.mse=false; next.startTime=at;
        trace('falling back to plain playback at '+Math.round(at)+'s');
        load(next);
      };
      engine.onAudioSwitch=function(index){
        if(!currentMedia)return;
        var next={}, at=v.currentTime||0;
        for(var key in currentMedia)next[key]=currentMedia[key];
        next.audioTypeIndex=index;next.subtitleTypeIndex=wantedSubtitle;next.startTime=at;
        load(next);
      };
      // Sidecar subtitle URLs are virtual in remote mode (see the poster note).
      if(!rtcMode) applySubtitles(m.subs);
      tryPlay();return;
    }
    if(rtcMode){
      show(idle);
      status.textContent='This TV can’t play that file remotely.';
      trace('rtc: no engine available for '+(m.url||'?')+' — MediaSource or mp4box missing');
      return;
    }
    v.src=m.url;
    applySubtitles(m.subs);
    tryPlay();
  }
  tap.onclick=function(){ tryPlay(); };
  v.addEventListener('loadedmetadata',function(){
    nativeTracksChanged();
    applyNativeAudioTrack();
    if(pendingStart>0){ try{v.currentTime=pendingStart}catch(e){} pendingStart=0; }
  });
  v.addEventListener('loadeddata',nativeTracksChanged);
  v.addEventListener('timeupdate',report); v.addEventListener('play',report);
  v.addEventListener('pause',report); v.addEventListener('ended',function(){
    send({type:'status',ended:true,position:v.currentTime,duration:v.duration||0,paused:true});
    show(idle);
    status.textContent='Finished — choose something else to play in '+SENDER;
  });
  var last=0;
  function report(){ var now=Date.now(); if(now-last<900) return; last=now;
    send({type:'status',position:v.currentTime||0,duration:isFinite(v.duration)?v.duration:0,paused:v.paused,ended:false}); }
  /* The LAN control socket always opens when the app serves this page (in
     remote mode it is the trace pipe); the data channel opens on top of it. */
  if(wsPort) connect();
  if(rtcMode){
    trace('rtc: remote mode room='+String(RTC_ROOM).slice(0,8)+' sig='+RTC_SIG.replace(/^https?:\/\//,''));
    reportRtcCaps();
    startRtc();
  }
})();

/* Shared by /tv and the hosted WebRTC viewer: strict ES5, a 2017 TV must parse it. */
(function(){
  var mpegResult=null, mpegWaiters=[];
  function mpegFrames(startSeconds){
    var muxer=new Fmp4Muxer({type:2,codecId:'A_MPEG/L3',codecDelayNs:23020833,audio:{sampleRate:48000,channels:1}},48000);
    var samples=[], i, frame;
    for(i=0;i<20;i++){
      frame=new Uint8Array(96); frame[0]=0xFF; frame[1]=0xFB; frame[2]=0x14; frame[3]=0xC0;
      samples.push({pts:startSeconds*48000+i*1152,data:frame});
    }
    return muxer.fragment(samples);
  }
  function mpegAppend(startSeconds,withOffset,done){
    var MS=window.MediaSource, finished=false, el=null, url='', timer=null;
    function end(ok,why){
      if(finished)return; finished=true; if(timer)clearTimeout(timer);
      try{el.removeAttribute('src');el.load();}catch(e){}
      try{if(url)URL.revokeObjectURL(url);}catch(e){}
      done(ok,why);
    }
    try{
      if(!MS||typeof Fmp4Muxer==='undefined'||!MS.isTypeSupported('audio/mpeg')){end(false,'not offered');return;}
      var ms=new MS(), frames=mpegFrames(startSeconds);
      el=document.createElement('audio'); el.muted=true;
      el.addEventListener('error',function(){end(false,'element error '+(el.error&&el.error.code));});
      ms.addEventListener('sourceopen',function(){
        try{
          var sb=ms.addSourceBuffer('audio/mpeg');
          sb.addEventListener('error',function(){end(false,'append error');});
          sb.addEventListener('updateend',function(){
            setTimeout(function(){
              try{
                var b=sb.buffered;
                if(el.error)end(false,'element error '+el.error.code);
                else if(!b.length||b.end(b.length-1)<=0)end(false,'nothing buffered');
                else if(el.readyState<1)end(false,'no metadata');
                else end(true,'buffered to '+b.end(b.length-1).toFixed(2)+' s');
              }catch(e){end(false,String(e&&e.name||e));}
            },300);
          });
          if(withOffset)sb.timestampOffset=frames.timestampOffset;
          sb.appendBuffer(frames);
        }catch(e){end(false,String(e&&e.name||e));}
      });
      url=URL.createObjectURL(ms); el.src=url;
      timer=setTimeout(function(){end(false,'timeout');},1200);
    }catch(e){end(false,String(e&&e.name||e));}
  }
  window.PortageMpegTrial=function(done){
    if(mpegResult){done(mpegResult);return;}
    mpegWaiters.push(done);
    if(mpegWaiters.length>1)return;
    var settle=function(result){
      mpegResult=result;
      var waiting=mpegWaiters; mpegWaiters=[];
      waiting.forEach(function(w){w(result);});
    };
    mpegAppend(0,true,function(ok,why){
      if(ok||why==='not offered'){settle({ok:ok,detail:'MP3 trial: '+(ok?'plays':'no')+' ('+why+')'});return;}
      mpegAppend(10,true,function(laterOk,laterWhy){
        mpegAppend(0,false,function(plainOk,plainWhy){
          settle({ok:false,detail:'MP3 trial: no with the lane\u2019s offset at the start ('+why+'); at 10 s '+
            (laterOk?'plays':'no ('+laterWhy+')')+'; without an offset '+(plainOk?'plays':'no ('+plainWhy+')')});
        });
      });
    });
  };
  window.PortageBrowserCapabilities=function(v,done,mediaSourceOnly){
    var caps={mse:!!window.MediaSource,mp4box:typeof MP4Box!=='undefined'}, pending=[];
    var nativeHls=!mediaSourceOnly&&!!v.canPlayType('application/vnd.apple.mpegurl');
    function support(mime){
      try { return (!!window.MediaSource&&window.MediaSource.isTypeSupported(mime)) || (nativeHls&&!!v.canPlayType(mime)); }
      catch(e){ return false; }
    }
    var formats={H264:'avc1.640028',H26410:'avc1.6e0028',HEVC8:'hvc1.1.6.L120.90',HEVC10:'hvc1.2.4.L120.90',AV1:'av01.0.08M.08',VP9:'vp09.00.40.08'};
    Object.keys(formats).forEach(function(name){
      caps['video'+name]=support('video/mp4; codecs="'+formats[name]+'"');
      [720,1080,2160].forEach(function(height){
        var width=height===720?1280:height===1080?1920:3840;
        var codec=formats[name];
        if(name.indexOf('H264')===0)codec=codec.slice(0,-2)+(height===2160?'33':'28');
        if(name.indexOf('HEVC')===0&&height===2160)codec=codec.replace('L120','L150');
        if(name==='AV1')codec=height===720?'av01.0.05M.08':height===1080?'av01.0.08M.08':'av01.0.12M.08';
        if(name==='VP9')codec=height===720?'vp09.00.31.08':height===1080?'vp09.00.40.08':'vp09.00.51.08';
        var fastCodec=codec;
        if(name.indexOf('H264')===0&&height>=1080)fastCodec=codec.slice(0,-2)+(height===2160?'34':'2a');
        if(name.indexOf('HEVC')===0&&height>=1080)fastCodec=height===2160?codec.replace('L150','L153'):codec.replace('L120','L123');
        if(name==='AV1'&&height>=1080)fastCodec=height===2160?'av01.0.13M.08':'av01.0.09M.08';
        if(name==='VP9'&&height===1080)fastCodec='vp09.00.41.08';
        var mime='video/mp4; codecs="'+codec+'"', key='picture'+name+height;
        caps[key]=support(mime);
        function measure(transfer,rate){
          if(!navigator.mediaCapabilities||!navigator.mediaCapabilities.decodingInfo)return;
          var video={contentType:rate?'video/mp4; codecs="'+fastCodec+'"':mime,width:width,height:height,bitrate:20000000,framerate:rate||30};
          var answerKey=key;
          if(transfer){video.colorGamut='rec2020';video.transferFunction=transfer;answerKey='picture'+name+'HDR'+transfer.toUpperCase()+height;}
          if(rate)answerKey+='F'+rate;
          if(transfer||rate)caps[answerKey]=false;
          try{pending.push(navigator.mediaCapabilities.decodingInfo({type:window.MediaSource?'media-source':'file',video:video}).then(function(answer){caps[answerKey]=answer.supported===true;},function(){}));}catch(e){}
        }
        measure(null);
        measure(null,60);
        if(name==='HEVC10'){measure('pq');measure('hlg');measure('pq',60);measure('hlg',60);}
      });
    });
    var audio={AAC:'mp4a.40.2',MP3:'mp4a.69',AC3:'ac-3',EC3:'ec-3',TrueHD:'mlpa',DTS:'dtsc',FLAC:'flac',Opus:'opus'};
    Object.keys(audio).forEach(function(name){caps['audio'+name]=support('audio/mp4; codecs="'+audio[name]+'"');});
    try{caps.audioMPEG=!!window.MediaSource&&window.MediaSource.isTypeSupported('audio/mpeg');}catch(e){caps.audioMPEG=false;}
    if(typeof Fmp4Muxer!=='undefined')Object.keys(Fmp4Muxer.packagedCodecs).forEach(function(id){caps['mkv'+Fmp4Muxer.packagedCodecs[id].toUpperCase()]=true;});
    caps.videoHEVC=caps.videoHEVC10||caps.videoHEVC8;
    // Native container support is a separate question from decode support.
    ['H264','HEVC'].forEach(function(name){caps['containerTS'+name]=!mediaSourceOnly&&!!v.canPlayType('video/mp2t; codecs="'+(name==='H264'?formats.H264:formats.HEVC8)+'"');});
    var measured=false, tried=false;
    function finish(){if(measured&&tried)done(caps);}
    window.PortageMpegTrial(function(result){caps.audioMPEG=caps.audioMPEG&&result.ok;tried=true;finish();});
    if(pending.length&&typeof Promise!=='undefined')Promise.all(pending).then(function(){measured=true;finish();});else{measured=true;finish();}
  };
  window.PortageCanPlayAnswer=function(v,msg,done,mediaSourceOnly){
    var MS=window.MediaSource, mc=navigator.mediaCapabilities, nativeHls=false;
    try{nativeHls=!mediaSourceOnly&&!!v.canPlayType('application/vnd.apple.mpegurl');}catch(e){}
    function plain(config){
      var mime=config.mime||(config.kind==='audio'?'audio/mp4':'video/mp4');
      return config.codecs&&mime!=='audio/mpeg'?mime+'; codecs="'+config.codecs+'"':mime;
    }
    // No eotf: the 2017 LG says no to every type that carries it.
    function sized(config){
      var type=plain(config);
      if(config.kind==='video')['width','height','framerate'].forEach(function(key){if(config[key])type+='; '+key+'='+config[key];});
      return type;
    }
    function mse(type){try{return !!MS&&MS.isTypeSupported(type);}catch(e){return false;}}
    function native(type){try{return v.canPlayType(type)!=='';}catch(e){return false;}}
    function screen(query){try{return !!window.matchMedia&&window.matchMedia(query).matches;}catch(e){return false;}}
    var probe={kind:'video',codecs:'avc1.42E01E',width:640,height:360,framerate:30};
    var takesSize=mse(sized(probe))||!mse(plain(probe));
    var configs=msg.configs||[], pending=0, sent=false;
    var answers=configs.map(function(config){
      var type=plain(config), yes=mse(type)&&(!takesSize||mse(sized(config)));
      return {mse:yes,display:yes||nativeHls&&native(type)};
    });
    function packs(codec){return typeof Fmp4Muxer!=='undefined'&&typeof Fmp4Muxer.carries==='function'&&Fmp4Muxer.carries(codec);}
    var containers=(msg.containers||[]).map(function(container){
      var codecs=String(container.codecs||'').split(',').map(function(c){return c.replace(/^\s+|\s+$/g,'');}).filter(function(c){return !!c;});
      var type=codecs.length?container.mime+'; codecs="'+codecs.join(',')+'"':container.mime, says='';
      try{says=v.canPlayType(type)||'';}catch(e){}
      return {canPlayType:says,display:!mediaSourceOnly&&says!=='',
              packs:container.mime==='video/x-matroska'&&!!MS&&typeof MkvEngine!=='undefined'&&codecs.length>0&&codecs.every(packs)};
    });
    var hdr=screen('(dynamic-range: high)');
    function reply(){
      if(sent)return; sent=true;
      done({type:'canPlayAnswer',id:msg.id,answers:answers,containers:containers,device:{IS_HDR_SUPPORTED:hdr,IS_DV_SUPPORTED:hdr}});
    }
    function settle(){pending--; if(pending<=0)reply();}
    function decoding(config,i){
      var info={type:MS?'media-source':'file'};
      if(config.kind==='video'){
        info.video={contentType:plain(config),width:config.width||1920,height:config.height||1080,
                    bitrate:config.bitrate||1000000,framerate:config.framerate||30};
        if(config.hdr){info.video.colorGamut='rec2020';info.video.transferFunction=config.hdr;}
      }else{
        info.audio={contentType:plain(config)};
        if(config.channels)info.audio.channels=String(config.channels);
      }
      pending++;
      try{
        mc.decodingInfo(info).then(function(result){
          if(!result||result.supported!==true){answers[i].mse=false;answers[i].display=false;}
          settle();
        },settle);
      }catch(e){settle();}
    }
    function measure(){
      if(mc&&typeof mc.decodingInfo==='function'&&typeof Promise!=='undefined'){
        pending++;
        configs.forEach(function(config,i){if(answers[i].display)decoding(config,i);});
        setTimeout(reply,1500);
        settle();
      }else reply();
    }
    var mpegAsks=[];
    configs.forEach(function(config,i){if(plain(config)==='audio/mpeg'&&answers[i].display)mpegAsks.push(i);});
    if(!mpegAsks.length||typeof window.PortageMpegTrial!=='function'){measure();return;}
    window.PortageMpegTrial(function(result){
      if(!result.ok)mpegAsks.forEach(function(i){answers[i].mse=false;answers[i].display=false;});
      measure();
    });
  };
})();

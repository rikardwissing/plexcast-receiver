/* Shared by /tv and the hosted WebRTC viewer: strict ES5, a 2017 TV must parse it. */
(function(){
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
        var mime='video/mp4; codecs="'+codec+'"', key='picture'+name+height;
        caps[key]=support(mime);
        function measure(transfer){
          if(!navigator.mediaCapabilities||!navigator.mediaCapabilities.decodingInfo)return;
          var video={contentType:mime,width:width,height:height,bitrate:20000000,framerate:30};
          var answerKey=key;
          if(transfer){video.colorGamut='rec2020';video.transferFunction=transfer;answerKey='picture'+name+'HDR'+transfer.toUpperCase()+height;caps[answerKey]=false;}
          try{pending.push(navigator.mediaCapabilities.decodingInfo({type:window.MediaSource?'media-source':'file',video:video}).then(function(answer){caps[answerKey]=answer.supported===true;},function(){}));}catch(e){}
        }
        measure(null);
        if(name==='HEVC10'){measure('pq');measure('hlg');}
      });
    });
    var audio={AAC:'mp4a.40.2',MP3:'mp4a.69',AC3:'ac-3',EC3:'ec-3',TrueHD:'mlpa',DTS:'dtsc',FLAC:'flac',Opus:'opus'};
    Object.keys(audio).forEach(function(name){caps['audio'+name]=support('audio/mp4; codecs="'+audio[name]+'"');});
    if(typeof Fmp4Muxer!=='undefined')Object.keys(Fmp4Muxer.packagedCodecs).forEach(function(id){caps['mkv'+Fmp4Muxer.packagedCodecs[id].toUpperCase()]=true;});
    caps.videoHEVC=caps.videoHEVC10||caps.videoHEVC8;
    // Native container support is a separate question from decode support.
    ['H264','HEVC'].forEach(function(name){caps['containerTS'+name]=!mediaSourceOnly&&!!v.canPlayType('video/mp2t; codecs="'+(name==='H264'?formats.H264:formats.HEVC8)+'"');});
    function finish(){done(caps);}
    if(pending.length&&typeof Promise!=='undefined')Promise.all(pending).then(finish);else finish();
  };
})();

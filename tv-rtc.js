/* WebRTC transport for the TV receiver — strict ES5, quarantined in its own
   script block like tv-mse.js so a parse failure here can never take the LAN
   receiver down with it (tv-main.js guards on typeof PlexRtc).

   Why this file exists at all: the hosted receiver (docs/rtc/index.html) is
   written in modern JS (async/await, promise-style RTC APIs, URLSearchParams)
   and carries its OWN, older MSE engine — on a 2017 TV it would fail to parse,
   and if it parsed it would still die the way our engine did before the
   keyframe-cut / per-buffer-mfhd / hand-built-init fixes. So instead of porting
   that page backwards, the proven engine gets a second byte source: this file
   speaks the same data-channel protocol the hosted page does, and hands
   tv-mse.js a fetcher. Same engine, two transports.

   Wire protocol (must stay identical to docs/rtc/index.html and the sender in
   WebRTCCastService.swift):
     out  {t:"req",  id, path, start?, end?}      request a byte window
     out  {t:"abort",id}                          cancel one in flight
     out  {t:"hello",label, pairings:[]}          on channel open
     out  {t:"status",gen,position,duration,paused[,ended]}
     in   {t:"res",  id, status, len, total, ctype}  response header
     in   binary: 4-byte LE id + payload; empty payload (4 bytes) = EOF
     in   {t:"err",  id, status}                  request failed
     in   {t:"hi"|"load"|"play"|"pause"|"seek"|"volume"|"stop"|
            "audioTrack"|"subtitleTrack"|"subs"|"pair"}  control */
(function(){
  function trace(message){ if(window.tvReport){try{window.tvReport(message);return}catch(e){}} try{console.log('plexcast:',message)}catch(e2){} }

  /* Chromium 38 exposes webkitRTCPeerConnection only, and its SDP objects must
     be real RTCSessionDescription instances rather than plain objects. */
  var PeerCtor=window.RTCPeerConnection||window.webkitRTCPeerConnection||window.mozRTCPeerConnection||null;
  var DescCtor=window.RTCSessionDescription||window.webkitRTCSessionDescription||window.mozRTCSessionDescription||null;
  var STUN=[{url:'stun:stun.l.google.com:19302'},{url:'stun:stun1.l.google.com:19302'},
            {url:'stun:stun.cloudflare.com:3478'}];

  /* Old engines want {url:...} entries; new ones want {urls:[...]}. Offer both
     shapes — each implementation reads the key it knows. */
  function iceConfig(){
    var servers=[],i;
    for(i=0;i<STUN.length;i++) servers.push({url:STUN[i].url,urls:[STUN[i].url]});
    return {iceServers:servers};
  }

  /* Promise-style and callback-style SDP APIs in one call: passing callbacks
     uses the legacy overload (still supported by modern browsers) and any
     returned promise is wired to the same handlers, so whichever the engine
     implements, exactly one path fires. */
  function sdpCall(pc,method,arg,ok,fail){
    var done=false;
    function good(x){ if(done)return; done=true; ok(x); }
    function bad(e){ if(done)return; done=true; fail(e); }
    var out;
    try{ out=arg!==null?pc[method](arg,good,bad):pc[method](good,bad); }
    catch(e){ bad(e); return; }
    if(out&&typeof out.then==='function') out.then(good,bad);
  }

  /* Rewrite a modern data-channel m-line into the 2013-era form. libwebrtc
     M150 offers "UDP/DTLS/SCTP webrtc-datachannel" + a=sctp-port; engines from
     the Chromium 38 era only parse "DTLS/SCTP <port>" + a=sctpmap. Used only
     as a retry after setRemoteDescription rejects the offer as-is. */
  function legacySdp(sdp){
    var port='5000', out=String(sdp);
    var portMatch=/a=sctp-port:(\d+)/.exec(out);
    if(portMatch) port=portMatch[1];
    out=out.replace(/^m=application (\d+) UDP\/DTLS\/SCTP webrtc-datachannel\s*$/m,
                    'm=application $1 DTLS/SCTP '+port);
    out=out.replace(/^a=sctp-port:\d+\s*$/m,'a=sctpmap:'+port+' webrtc-datachannel 1024');
    return out;
  }

  function PlexRtc(room,sigBase,handlers){
    this.room=String(room||'');
    this.sig=String(sigBase||'').replace(/\/+$/,'');
    this.handlers=handlers||{};
    this.socket=null; this.channel=null; this.peer=null;
    this.session=(new Date().getTime().toString(36))+Math.random().toString(36).slice(2);
    this.generation=null; this.answered=false; this.opened=false; this.closed=false;
    this.retry=500; this.attempts=0;
    this.reqId=1; this.pending={};
  }

  PlexRtc.prototype.state=function(text){
    if(this.handlers.onState) try{this.handlers.onState(text)}catch(e){}
  };

  PlexRtc.prototype.start=function(){
    if(!PeerCtor){
      trace('rtc: this browser has no RTCPeerConnection — remote casting unavailable');
      this.state('This TV browser has no WebRTC support.');
      if(this.handlers.onFatal)this.handlers.onFatal('no RTCPeerConnection');
      return;
    }
    this.openSignal();
  };

  PlexRtc.prototype.openSignal=function(){
    var self=this;
    if(this.closed) return;
    var base=this.sig.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
    var url=base+'/rtc/ws/'+encodeURIComponent(this.room)+'?role=viewer&session='+encodeURIComponent(this.session);
    var ws;
    try{ ws=new WebSocket(url); }
    catch(err){ trace('rtc: signalling socket failed: '+err); this.state('Signalling unavailable — retrying…'); setTimeout(function(){self.openSignal()},2000); return; }
    this.socket=ws;
    this.state('Connecting to the signalling service…');
    ws.onopen=function(){ trace('rtc: signalling open room='+self.room.slice(0,8)); };
    ws.onmessage=function(event){
      var message;
      try{ message=JSON.parse(event.data); }catch(e){ return; }
      if(message.type==='ready'){
        self.retry=500;
        trace('rtc: signalling ready — waiting for an offer');
        self.state('Waiting for the sender…');
      }else if(message.type==='offer'&&message.sdp&&message.generation){
        if(self.answered&&self.generation===message.generation) return;
        self.generation=message.generation;
        self.answer(message.sdp);
      }else if(message.type==='error'){
        trace('rtc: signalling error: '+(message.message||'?'));
        self.state(message.message||'The signalling service rejected this connection.');
      }
    };
    ws.onclose=function(){
      if(self.socket!==ws||self.closed) return;
      var delay=self.retry;
      self.retry=Math.min(Math.round(self.retry*1.7),8000);
      trace('rtc: signalling closed — retrying in '+delay+'ms');
      setTimeout(function(){ self.openSignal(); },delay);
    };
    ws.onerror=function(){ try{ws.close()}catch(e){} };
  };

  PlexRtc.prototype.sendSignal=function(obj){
    if(this.socket&&this.socket.readyState===1){
      try{ this.socket.send(JSON.stringify(obj)); return true; }catch(e){}
    }
    return false;
  };

  PlexRtc.prototype.answer=function(offerBlob){
    var self=this;
    this.attempts++;
    var offer;
    try{ offer=JSON.parse(atob(offerBlob)); }
    catch(e){ trace('rtc: offer decode failed: '+e); return; }
    trace('rtc: offer received gen='+this.generation+' len='+String(offerBlob).length);

    var pc;
    try{ pc=new PeerCtor(iceConfig()); }
    catch(e2){
      trace('rtc: RTCPeerConnection ctor threw: '+e2);
      this.state('This TV browser cannot open a WebRTC connection.');
      if(this.handlers.onFatal)this.handlers.onFatal('ctor threw');
      return;
    }
    this.closePeer();
    this.peer=pc;
    window.__rtcpc=pc;                                       // QA/debug handle

    pc.oniceconnectionstatechange=function(){ trace('rtc: ice '+pc.iceConnectionState); };
    if('onicegatheringstatechange' in pc)
      pc.onicegatheringstatechange=function(){ trace('rtc: gathering '+pc.iceGatheringState); };
    /* connectionState is Chrome 72+; on old engines this simply never fires and
       a dead link surfaces through ice state / channel close instead. */
    pc.onconnectionstatechange=function(){ trace('rtc: conn '+pc.connectionState); };
    pc.ondatachannel=function(e){ self.adopt(e.channel); };

    function describe(sdp,isRetry){
      var desc;
      try{ desc=DescCtor?new DescCtor({type:offer.type||'offer',sdp:sdp}):{type:offer.type||'offer',sdp:sdp}; }
      catch(eDesc){ trace('rtc: RTCSessionDescription threw: '+eDesc); return; }
      sdpCall(pc,'setRemoteDescription',desc,function(){
        trace('rtc: remote description set'+(isRetry?' (legacy SCTP rewrite)':''));
        self.createAnswer(pc);
      },function(err){
        var text=String(err&&err.message||err);
        trace('rtc: setRemoteDescription failed'+(isRetry?' (retry)':'')+': '+text);
        if(!isRetry){
          var rewritten=legacySdp(sdp);
          if(rewritten!==sdp){ trace('rtc: retrying with legacy DTLS/SCTP m-line'); describe(rewritten,true); return; }
        }
        self.state('This TV browser could not read the connection offer.');
        if(self.handlers.onFatal)self.handlers.onFatal('setRemoteDescription: '+text);
      });
    }
    this.state('Connecting to the sender…');
    describe(offer.sdp,false);
  };

  PlexRtc.prototype.createAnswer=function(pc){
    var self=this;
    sdpCall(pc,'createAnswer',null,function(answer){
      sdpCall(pc,'setLocalDescription',answer,function(){
        trace('rtc: local answer set — gathering candidates');
        self.whenGathered(pc,function(){ self.postAnswer(pc); });
      },function(err){ trace('rtc: setLocalDescription failed: '+err); });
    },function(err){ trace('rtc: createAnswer failed: '+err); });
  };

  /* Non-trickle, exactly like the hosted receiver: post one complete answer
     after gathering finishes (or 4s, whichever comes first). */
  PlexRtc.prototype.whenGathered=function(pc,done){
    if(pc.iceGatheringState==='complete'){ done(); return; }
    var fired=false;
    function finish(){ if(fired)return; fired=true; done(); }
    var timer=setTimeout(function(){ trace('rtc: gathering timeout — answering anyway'); finish(); },4000);
    pc.onicegatheringstatechange=function(){
      trace('rtc: gathering '+pc.iceGatheringState);
      if(pc.iceGatheringState==='complete'){ clearTimeout(timer); finish(); }
    };
  };

  PlexRtc.prototype.postAnswer=function(pc){
    var local=pc.localDescription;
    if(!local||!local.sdp){ trace('rtc: no local description to post'); return; }
    var blob;
    try{ blob=btoa(JSON.stringify({type:local.type,sdp:local.sdp})); }
    catch(e){ trace('rtc: answer encode failed: '+e); return; }
    this.answered=this.sendSignal({type:'answer',generation:this.generation,sdp:blob});
    trace('rtc: answer '+(this.answered?'posted':'NOT posted (socket closed)')+' gen='+this.generation);
    var self=this;
    setTimeout(function(){
      if(self.closed||self.opened) return;
      trace('rtc: no data channel 15s after answering — DTLS/SCTP or NAT problem');
      self.state('Could not finish connecting to the sender.');
    },15000);
  };

  PlexRtc.prototype.adopt=function(channel){
    var self=this;
    this.channel=channel;
    channel.binaryType='arraybuffer';
    trace('rtc: data channel "'+(channel.label||'?')+'" '+channel.readyState);
    channel.onopen=function(){
      self.opened=true;
      trace('rtc: data channel open — connected to the sender');
      self.state('');
      self.send({t:'hello',label:'TV',pairings:[]});
      if(self.handlers.onOpen) try{self.handlers.onOpen()}catch(e){}
    };
    channel.onclose=function(){
      trace('rtc: data channel closed');
      self.rejectAll(new Error('channel closed'));
      if(self.handlers.onClose) try{self.handlers.onClose()}catch(e){}
    };
    channel.onerror=function(e){ trace('rtc: data channel error: '+(e&&e.message||e)); };
    channel.onmessage=function(ev){
      if(typeof ev.data==='string'){
        var obj;
        try{ obj=JSON.parse(ev.data); }catch(e){ return; }
        self.onControl(obj);
      }else self.onBody(ev.data);
    };
    if(channel.readyState==='open') channel.onopen();
  };

  PlexRtc.prototype.send=function(obj){
    if(this.channel&&this.channel.readyState==='open'){
      try{ this.channel.send(JSON.stringify(obj)); return true; }catch(e){}
    }
    return false;
  };

  PlexRtc.prototype.onControl=function(obj){
    if(obj.t==='res'){
      var p=this.pending[obj.id];
      if(p){ p.meta=obj; this.arm(obj.id); }
      return;
    }
    if(obj.t==='err'){
      var pe=this.pending[obj.id];
      if(pe) this.reject(obj.id,new Error('status '+obj.status),false);
      return;
    }
    if(this.handlers.onControl) try{this.handlers.onControl(obj)}catch(e){}
  };

  /* Body chunks: 4-byte LE request id, then payload; a bare 4-byte frame is
     EOF. Chunks are concatenated only at EOF so mp4box sees one buffer. */
  PlexRtc.prototype.onBody=function(buf){
    if(!buf||buf.byteLength<4) return;
    var view=new DataView(buf);
    var id=view.getUint32(0,true);
    var p=this.pending[id];
    if(!p) return;
    if(buf.byteLength===4){
      delete this.pending[id];
      this.clear(p);
      var out=new Uint8Array(p.got), off=0, i;
      for(i=0;i<p.chunks.length;i++){ out.set(p.chunks[i],off); off+=p.chunks[i].length; }
      var meta=p.meta||{};
      p.done(null,{buffer:out.buffer,total:(meta.total!=null?meta.total:null),status:(meta.status||206)});
      return;
    }
    p.chunks.push(new Uint8Array(buf,4));
    p.got+=buf.byteLength-4;
    this.arm(id);
  };

  PlexRtc.prototype.clear=function(p){ if(p&&p.timer){ clearTimeout(p.timer); p.timer=null; } };

  /* Inactivity deadline, not a whole-request deadline: every header and chunk
     rearms it, so a slow link takes as long as it needs while a wedged SCTP
     request can't strand the engine's pump forever. */
  PlexRtc.prototype.arm=function(id){
    var self=this, p=this.pending[id];
    if(!p) return;
    this.clear(p);
    p.timer=setTimeout(function(){
      if(self.pending[id]!==p) return;
      trace('rtc: request #'+id+' stalled — aborting');
      self.reject(id,new Error('request made no progress'),true);
    },15000);
  };

  PlexRtc.prototype.reject=function(id,error,sendAbort){
    var p=this.pending[id];
    if(!p) return;
    delete this.pending[id];
    this.clear(p);
    if(sendAbort) this.send({t:'abort',id:id});
    p.done(error,null);
  };

  /* A caller-initiated abort is NOT a failure: XHR reports it through onabort
     rather than onerror, and the engine cancels its in-flight window on every
     seek. Reporting it as an error would kill the engine mid-seek, so drop the
     request silently and only tell the sender to stop streaming it. */
  PlexRtc.prototype.cancel=function(id){
    var p=this.pending[id];
    if(!p) return;
    delete this.pending[id];
    this.clear(p);
    this.send({t:'abort',id:id});
  };

  PlexRtc.prototype.rejectAll=function(error){
    var ids=[],k;
    for(k in this.pending) if(Object.prototype.hasOwnProperty.call(this.pending,k)) ids.push(k);
    for(var i=0;i<ids.length;i++) this.reject(Number(ids[i]),error,false);
  };

  /* The engine's byte source: fetch(path,start,endInclusive,cb) -> {abort} */
  PlexRtc.prototype.fetcher=function(){
    var self=this;
    return function(path,start,end,cb){
      if(!self.channel||self.channel.readyState!=='open'){ cb(new Error('channel closed'),null); return {abort:function(){}}; }
      var id=self.reqId++;
      self.pending[id]={done:cb,meta:null,chunks:[],got:0,timer:null};
      var msg={t:'req',id:id,path:path};
      if(start!=null) msg.start=start;
      if(end!=null) msg.end=end;
      self.arm(id);
      if(!self.send(msg)) self.reject(id,new Error('send failed'),false);
      return {abort:function(){ self.cancel(id); }};
    };
  };

  PlexRtc.prototype.closePeer=function(){
    if(this.peer){ try{this.peer.close()}catch(e){} this.peer=null; }
    this.channel=null; this.opened=false; this.answered=false;
  };

  PlexRtc.prototype.close=function(){
    this.closed=true;
    this.rejectAll(new Error('closed'));
    this.closePeer();
    if(this.socket){ try{this.socket.close()}catch(e){} this.socket=null; }
  };

  window.PlexRtc=PlexRtc;
})();

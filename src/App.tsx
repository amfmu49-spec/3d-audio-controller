import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, RotateCw, Headphones, Volume2, FileAudio, Maximize2 } from 'lucide-react';

interface Speaker {
  id: number;
  angleOffset: number; // 回転の位相差
  heightOffset: number; // 高さの位相差
  color: string;
}

const EQ_TEMPLATES = {
  Flat: [0, 0, 0, 0, 0],
  'Bass Boost': [6, 3, 0, 0, 0],
  'Treble Boost': [0, 0, 0, 3, 6],
  Vocal: [-2, 0, 4, 2, -2],
  Electronic: [5, 2, -2, 2, 5],
};

const REVERB_PRESETS = {
  Dry: 0.05,
  Natural: 0.15,
  Cathedral: 0.4,
};

export default function App() {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAutoRotate, setIsAutoRotate] = useState(false);
  const [isAutoHeight, setIsAutoHeight] = useState(false);
  const [speakers, setSpeakers] = useState<Speaker[]>([
    { id: 1, angleOffset: 0, heightOffset: 0, color: '#10b981' }
  ]);
  const [angle, setAngle] = useState(0); // 基本の角度
  const [height, setHeight] = useState(0); // 基本の高さ
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const [eqTemplate, setEqTemplate] = useState<keyof typeof EQ_TEMPLATES>('Flat');
  const [reverbPreset, setReverbPreset] = useState<keyof typeof REVERB_PRESETS>('Natural');
  
  const audioCtxRef = useRef<AudioContext | null>(null);
  const speakerNodesRef = useRef<Map<number, { panner: PannerNode, filter: BiquadFilterNode }>>(new Map());
  const reverbRef = useRef<ConvolverNode | null>(null);
  const reverbGainRef = useRef<GainNode | null>(null);
  const eqNodesRef = useRef<BiquadFilterNode[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  
  const angleRef = useRef(0);
  const heightRef = useRef(0);
  const isDragging = useRef(false);
  const heightTimeRef = useRef(0);

  // インパルス応答（リバーブ用）の生成
  const createImpulseResponse = (ctx: AudioContext) => {
    const length = ctx.sampleRate * 2.5; // 2.5秒の残響
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        // 指数関数的に減衰するホワイトノイズ
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 1.5);
      }
    }
    return buffer;
  };

  // AudioContextの初期化
  const initAudioContext = async () => {
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      return audioCtxRef.current;
    }
    
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContextClass();
    
    const reverb = ctx.createConvolver();
    reverb.buffer = createImpulseResponse(ctx);

    const reverbGain = ctx.createGain();
    reverbGain.gain.value = REVERB_PRESETS[reverbPreset];

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);

    // イコライザー設定 (5バンド)
    const frequencies = [60, 250, 1000, 4000, 12000];
    const eqNodes = frequencies.map((freq, i) => {
      const node = ctx.createBiquadFilter();
      node.type = i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking';
      node.frequency.value = freq;
      node.Q.value = 1;
      node.gain.value = EQ_TEMPLATES[eqTemplate][i];
      return node;
    });

    // EQチェーンの接続
    for (let i = 0; i < eqNodes.length - 1; i++) {
      eqNodes[i].connect(eqNodes[i + 1]);
    }

    reverb.connect(reverbGain);
    reverbGain.connect(ctx.destination);
    
    // リスナー設定
    if (ctx.listener.positionX) {
      ctx.listener.positionX.setValueAtTime(0, ctx.currentTime);
      ctx.listener.positionY.setValueAtTime(0, ctx.currentTime);
      ctx.listener.positionZ.setValueAtTime(0, ctx.currentTime);
      ctx.listener.forwardX.setValueAtTime(0, ctx.currentTime);
      ctx.listener.forwardY.setValueAtTime(0, ctx.currentTime);
      ctx.listener.forwardZ.setValueAtTime(-1, ctx.currentTime);
      ctx.listener.upX.setValueAtTime(0, ctx.currentTime);
      ctx.listener.upY.setValueAtTime(1, ctx.currentTime);
      ctx.listener.upZ.setValueAtTime(0, ctx.currentTime);
    } else {
      ctx.listener.setPosition(0, 0, 0);
      ctx.listener.setOrientation(0, 0, -1, 0, 1, 0);
    }
    
    audioCtxRef.current = ctx;
    reverbRef.current = reverb;
    reverbGainRef.current = reverbGain;
    eqNodesRef.current = eqNodes;
    analyserRef.current = analyser;

    // スピーカーごとのノード作成
    speakers.forEach(speaker => {
      createSpeakerNodes(ctx, speaker);
    });

    if (audioRef.current && !sourceNodeRef.current) {
      const source = ctx.createMediaElementSource(audioRef.current);
      
      // ソース -> EQチェーン
      source.connect(eqNodes[0]);
      
      // EQチェーンの最後 -> 他のノード
      const lastEq = eqNodes[eqNodes.length - 1];
      lastEq.connect(reverb);
      lastEq.connect(analyser);
      
      sourceNodeRef.current = source;
      
      // 作成済みのスピーカーに接続
      speakerNodesRef.current.forEach(nodes => {
        lastEq.connect(nodes.filter);
      });
    }

    setIsInitialized(true);
    return ctx;
  };

  const updateEQ = (templateName: keyof typeof EQ_TEMPLATES) => {
    setEqTemplate(templateName);
    if (audioCtxRef.current && eqNodesRef.current.length > 0) {
      const gains = EQ_TEMPLATES[templateName];
      eqNodesRef.current.forEach((node, i) => {
        node.gain.setTargetAtTime(gains[i], audioCtxRef.current!.currentTime, 0.1);
      });
    }
  };

  const updateReverb = (presetName: keyof typeof REVERB_PRESETS) => {
    setReverbPreset(presetName);
    if (audioCtxRef.current && reverbGainRef.current) {
      reverbGainRef.current.gain.setTargetAtTime(REVERB_PRESETS[presetName], audioCtxRef.current!.currentTime, 0.1);
    }
  };

  const createSpeakerNodes = (ctx: AudioContext, speaker: Speaker) => {
    if (speakerNodesRef.current.has(speaker.id)) return;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 10000;
    panner.rolloffFactor = 1;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';

    filter.connect(panner);
    panner.connect(ctx.destination);

    speakerNodesRef.current.set(speaker.id, { panner, filter });

    if (sourceNodeRef.current && eqNodesRef.current.length > 0) {
      const lastEq = eqNodesRef.current[eqNodesRef.current.length - 1];
      lastEq.connect(filter);
    }
  };

  const addSpeaker = (clickX?: number, clickY?: number) => {
    if (speakers.length >= 8) return; // 最大8台までに拡張

    const newId = Date.now();
    const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
    
    let angleOffset = Math.random() * Math.PI * 2;
    let heightOffset = Math.random() * Math.PI * 2;

    if (clickX !== undefined && clickY !== undefined) {
      // タップ位置から角度を計算
      const targetAngle = Math.atan2(clickX - 150, 150 - clickY);
      angleOffset = (targetAngle - angleRef.current + Math.PI * 2) % (Math.PI * 2);

      // 中心からの距離で高さをシミュレート (半径100が基準)
      const dist = Math.sqrt(Math.pow(clickX - 150, 2) + Math.pow(clickY - 150, 2));
      const targetHeight = Math.max(-1, Math.min(1, (dist - 100) / 50));
      
      if (isAutoHeight) {
        // sin波の逆関数で位相を合わせる（大まかな近似）
        heightOffset = Math.asin(targetHeight) - heightTimeRef.current;
      } else {
        // 固定高さの場合はオフセットとして保持（簡易化のためランダムか0）
        heightOffset = 0;
      }
    }

    const newSpeaker: Speaker = {
      id: newId,
      angleOffset,
      heightOffset,
      color: colors[speakers.length % colors.length]
    };

    setSpeakers(prev => [...prev, newSpeaker]);
    
    if (audioCtxRef.current && isInitialized) {
      createSpeakerNodes(audioCtxRef.current, newSpeaker);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    let x, y;
    
    if ('touches' in e) {
      x = e.touches[0].clientX - rect.left;
      y = e.touches[0].clientY - rect.top;
    } else {
      x = e.clientX - rect.left;
      y = e.clientY - rect.top;
    }

    // キャンバスの表示サイズと内部サイズ(300x300)の比率を考慮
    const scaleX = 300 / rect.width;
    const scaleY = 300 / rect.height;
    
    addSpeaker(x * scaleX, y * scaleY);
  };

  const removeSpeaker = () => {
    if (speakers.length <= 1) return;
    const lastSpeaker = speakers[speakers.length - 1];
    const nodes = speakerNodesRef.current.get(lastSpeaker.id);
    
    if (nodes) {
      nodes.filter.disconnect();
      nodes.panner.disconnect();
      speakerNodesRef.current.delete(lastSpeaker.id);
    }
    
    setSpeakers(speakers.slice(0, -1));
  };

  // ファイル選択
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setIsLoading(true);

    // 50MB以上の場合は警告（制限ではないがメモリリスク）
    if (file.size > 50 * 1024 * 1024) {
      console.warn("Large file detected. Memory issues may occur.");
    }

    setFileName(file.name);
    const url = URL.createObjectURL(file);
    
    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.load();
      // 読み込み完了待ち
      audioRef.current.oncanplaythrough = () => {
        setIsLoading(false);
      };
      audioRef.current.onerror = () => {
        setError("ファイルの読み込みに失敗しました。形式が対応していない可能性があります。");
        setIsLoading(false);
      };
    }
    
    setIsPlaying(false);
  };

  const toggleSound = async (e: React.MouseEvent) => {
    e.preventDefault(); // 念のためデフォルト動作を防止
    
    if (!fileName || !audioRef.current) {
      alert("先にMP3を選択してください");
      return;
    }

    // 再生ボタン押下時にコンテキストを初期化/再開
    const ctx = await initAudioContext();

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (err) {
        console.error("Playback failed:", err);
        alert("再生を開始できませんでした。ブラウザの設定で音声を許可してください。");
      }
    }
  };

  const updateSpatialAudio = () => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    
    speakers.forEach(speaker => {
      const nodes = speakerNodesRef.current.get(speaker.id);
      if (!nodes) return;

      const currentAngle = angleRef.current + speaker.angleOffset;
      const currentHeight = isAutoHeight 
        ? Math.sin(heightTimeRef.current + speaker.heightOffset) 
        : heightRef.current;

      // x: 左右, y: 上下, z: 前後
      const x = Math.sin(currentAngle) * 5;
      const z = -Math.cos(currentAngle) * 5;
      const y = currentHeight * 4;
      
      if (nodes.panner.positionX) {
        nodes.panner.positionX.setTargetAtTime(x, ctx.currentTime, 0.1);
        nodes.panner.positionY.setTargetAtTime(y, ctx.currentTime, 0.1);
        nodes.panner.positionZ.setTargetAtTime(z, ctx.currentTime, 0.1);
      } else {
        nodes.panner.setPosition(x, y, z);
      }

      const cosA = Math.cos(currentAngle);
      const filterFreq = 20000 - ( (1 - cosA) / 2 ) * 16000;
      nodes.filter.frequency.setTargetAtTime(Math.max(3000, filterFreq), ctx.currentTime, 0.1);
    });
  };

  useEffect(() => {
    let frame: number;
    const loop = () => {
      if (isAutoRotate && !isDragging.current) {
        angleRef.current = (angleRef.current + 0.025) % (Math.PI * 2);
        setAngle(angleRef.current);
      }
      if (isAutoHeight && isPlaying) {
        heightTimeRef.current += 0.015;
      }
      updateSpatialAudio();
      draw();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [isAutoRotate, isAutoHeight, isInitialized, isPlaying, speakers]);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 音量解析
    let volume = 0;
    if (analyserRef.current && dataArrayRef.current) {
      analyserRef.current.getByteFrequencyData(dataArrayRef.current);
      const sum = dataArrayRef.current.reduce((a, b) => a + b, 0);
      volume = sum / dataArrayRef.current.length;
    }

    ctx.clearRect(0, 0, 300, 300);
    
    // 背景のグロー効果
    if (isPlaying) {
      const gradient = ctx.createRadialGradient(150, 150, 0, 150, 150, 150);
      gradient.addColorStop(0, `rgba(16, 185, 129, ${volume / 500})`);
      gradient.addColorStop(1, 'transparent');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 300, 300);
    }

    // 軌道
    ctx.beginPath(); ctx.arc(150, 150, 100, 0, Math.PI * 2);
    ctx.strokeStyle = isPlaying ? `rgba(16, 185, 129, ${0.1 + volume / 255})` : '#222'; 
    ctx.setLineDash([3, 6]); ctx.stroke();
    
    // 頭（自分）
    ctx.setLineDash([]); 
    const headPulse = isPlaying ? volume / 20 : 0;
    ctx.beginPath(); ctx.arc(150, 150, 22 + headPulse, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill(); 
    ctx.strokeStyle = isPlaying ? '#10b981' : '#444'; ctx.lineWidth = 2; ctx.stroke();
    
    // 鼻（向き）
    ctx.beginPath(); ctx.moveTo(146, 132); ctx.lineTo(150, 118 - headPulse); ctx.lineTo(154, 132); 
    ctx.fillStyle = isPlaying ? '#10b981' : '#444'; ctx.fill();
    
    // 各スピーカーの描画
    speakers.forEach(speaker => {
      const currentAngle = angleRef.current + speaker.angleOffset;
      const currentHeight = isAutoHeight 
        ? Math.sin(heightTimeRef.current + speaker.heightOffset) 
        : heightRef.current;

      const x = 150 + Math.sin(currentAngle) * 100;
      const y = 150 - Math.cos(currentAngle) * 100;
      
      const scale = 1 + currentHeight * 0.4;
      const opacity = 0.5 + currentHeight * 0.5;

      if (isPlaying) {
        const waveSize = (volume / 2) % 40;
        ctx.beginPath(); ctx.arc(x, y, (10 + waveSize) * scale, 0, Math.PI * 2);
        ctx.strokeStyle = `${speaker.color}${Math.floor((1 - waveSize / 40) * opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.stroke();

        ctx.beginPath(); ctx.arc(x, y, (16 + volume / 10) * scale, 0, Math.PI * 2);
        ctx.fillStyle = `${speaker.color}33`; ctx.fill();
      }

      // スピーカー本体
      ctx.beginPath(); ctx.arc(x, y, 10 * scale, 0, Math.PI * 2);
      ctx.fillStyle = isPlaying ? speaker.color : '#555'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      
      // 影
      ctx.beginPath(); ctx.arc(x, y + 20, 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${0.3 - currentHeight * 0.2})`; ctx.fill();
    });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm bg-zinc-900 rounded-[3rem] p-8 border border-zinc-800 shadow-2xl">
        
        <h1 className="text-center text-xl font-bold mb-6 text-zinc-200">3D MP3 Player</h1>

        <div className="mb-8">
          <label className="block w-full cursor-pointer">
            <div className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-3xl transition-all ${
              error ? 'border-red-500/50 bg-red-500/5' : 
              isLoading ? 'border-blue-500/50 bg-blue-500/5 animate-pulse' :
              'border-emerald-500/30 bg-emerald-500/5 active:bg-emerald-500/10'
            }`}>
              <FileAudio className={`w-10 h-10 mb-3 ${error ? 'text-red-500' : isLoading ? 'text-blue-500' : 'text-emerald-500'}`} />
              <span className={`text-sm font-bold text-center px-2 truncate w-full ${error ? 'text-red-400' : isLoading ? 'text-blue-400' : 'text-emerald-400'}`}>
                {isLoading ? "読み込み中..." : error ? "エラーが発生しました" : fileName ? fileName : "ここをタップしてMP3を選択"}
              </span>
              {error && <p className="text-[10px] text-red-500 mt-2 text-center">{error}</p>}
              {!error && !isLoading && <p className="text-[10px] text-zinc-500 mt-2 uppercase tracking-widest">Tap to load music</p>}
            </div>
            <input 
              type="file" 
              accept="audio/mp3,audio/mpeg,audio/*" 
              className="hidden" 
              onChange={handleFileChange} 
            />
          </label>
        </div>

        <div className="relative flex justify-center mb-8 group">
          <canvas 
            ref={canvasRef} width={300} height={300} 
            className="w-full aspect-square touch-none cursor-crosshair bg-zinc-900/50 rounded-full border border-white/5 shadow-inner"
            onClick={handleCanvasClick}
            onPointerDown={(e) => { isDragging.current = true; (e.target as any).setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => {
              if (!isDragging.current) return;
              const rect = canvasRef.current!.getBoundingClientRect();
              const x = e.clientX - rect.left - 150;
              const y = 150 - (e.clientY - rect.top);
              let a = Math.atan2(x, y);
              if (a < 0) a += Math.PI * 2;
              angleRef.current = a; setAngle(a);
            }}
            onPointerUp={() => isDragging.current = false}
          />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[8px] text-zinc-500 font-bold uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Tap to add speaker
          </div>
          {!isInitialized && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/60 backdrop-blur-[2px] rounded-full">
              <p className="text-zinc-400 text-xs font-medium">上のボタンからMP3を選択</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <audio ref={audioRef} loop className="hidden" />
          <button 
            onClick={toggleSound} 
            disabled={!fileName || isLoading}
            className={`w-full py-5 rounded-2xl font-black text-xl flex items-center justify-center gap-3 transition-all ${
              !fileName || isLoading ? 'bg-zinc-800 text-zinc-600 opacity-50' : 
              isPlaying ? 'bg-zinc-800 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-600 shadow-lg'
            }`}
          >
            {isPlaying ? <Square className="fill-current w-5 h-5" /> : <Play className="fill-current w-5 h-5" />}
            {isPlaying ? 'STOP' : 'PLAY'}
          </button>

        {/* 3Dコントロールパネル */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <button 
            onClick={() => setIsAutoRotate(!isAutoRotate)}
            className={`p-4 rounded-2xl flex flex-col items-center gap-2 transition-all ${isAutoRotate ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-400'}`}
          >
            <RotateCw className={`w-5 h-5 ${isAutoRotate ? 'animate-spin-slow' : ''}`} />
            <span className="text-[10px] font-bold uppercase tracking-wider">Auto Spin</span>
          </button>
          
          <button 
            onClick={() => setIsAutoHeight(!isAutoHeight)}
            className={`p-4 rounded-2xl flex flex-col items-center gap-2 transition-all ${isAutoHeight ? 'bg-blue-500/20 border border-blue-500/50 text-blue-400' : 'bg-zinc-800/50 border border-white/5 text-zinc-400'}`}
          >
            <Maximize2 className={`w-5 h-5 ${isAutoHeight ? 'animate-bounce' : ''}`} />
            <span className="text-[10px] font-bold uppercase tracking-wider">3D Height</span>
          </button>
        </div>

        {/* スピーカー追加/削除 */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <button 
            onClick={() => addSpeaker()}
            disabled={speakers.length >= 8}
            className="p-3 rounded-xl bg-zinc-800 border border-white/5 text-zinc-300 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-700 disabled:opacity-30"
          >
            + Add Random
          </button>
          <button 
            onClick={removeSpeaker}
            disabled={speakers.length <= 1}
            className="p-3 rounded-xl bg-zinc-800 border border-white/5 text-zinc-300 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-700 disabled:opacity-30"
          >
            - Remove
          </button>
        </div>

        {/* イコライザー */}
        <div className="mb-6">
          <div className="flex justify-between mb-3">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Equalizer</span>
            <span className="text-[10px] font-mono text-emerald-500">{eqTemplate}</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {Object.keys(EQ_TEMPLATES).map((name) => (
              <button
                key={name}
                onClick={() => updateEQ(name as keyof typeof EQ_TEMPLATES)}
                className={`flex-shrink-0 px-3 py-2 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all ${
                  eqTemplate === name 
                    ? 'bg-emerald-500 text-zinc-950' 
                    : 'bg-zinc-800 text-zinc-500 border border-white/5 hover:bg-zinc-700'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        {/* リバーブ */}
        <div className="mb-8">
          <div className="flex justify-between mb-3">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Reverb Depth</span>
            <span className="text-[10px] font-mono text-blue-400">{reverbPreset}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Object.keys(REVERB_PRESETS).map((name) => (
              <button
                key={name}
                onClick={() => updateReverb(name as keyof typeof REVERB_PRESETS)}
                className={`py-2 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all ${
                  reverbPreset === name 
                    ? 'bg-blue-500 text-zinc-950' 
                    : 'bg-zinc-800 text-zinc-500 border border-white/5 hover:bg-zinc-700'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        {/* 高さスライダー */}
        <div className="mb-8 px-4">
          <div className="flex justify-between mb-2">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Vertical Position</span>
            <span className="text-[10px] font-mono text-emerald-500">{(height * 100).toFixed(0)}%</span>
          </div>
          <input 
            type="range" min="-1" max="1" step="0.01" 
            value={height} 
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setHeight(val);
              heightRef.current = val;
              setIsAutoHeight(false);
            }}
            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
        </div>
        </div>
        
        <div className="mt-8 flex items-center justify-center gap-2 text-zinc-600 text-[9px] uppercase tracking-[0.2em]">
          <Headphones className="w-3 h-3" /> Use Headphones
        </div>
      </div>
    </div>
  );
}

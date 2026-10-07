import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, RotateCw, Headphones, Volume2, FileAudio, Maximize2, Repeat, Repeat1, Radio } from 'lucide-react';

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
  const [isLoop, setIsLoop] = useState(true);
  const [speakers, setSpeakers] = useState<Speaker[]>([
    { id: 1, angleOffset: 0, heightOffset: 0, color: '#10b981' }
  ]);
  const [angle, setAngle] = useState(0); // 基本の角度
  const [height, setHeight] = useState(0); // 基本の高さ
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // 再生タイムライン
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  const [eqTemplate, setEqTemplate] = useState<keyof typeof EQ_TEMPLATES>('Flat');
  const [reverbPreset, setReverbPreset] = useState<keyof typeof REVERB_PRESETS>('Natural');

  const audioCtxRef = useRef<AudioContext | null>(null);
  const speakerNodesRef = useRef<Map<number, { panner: PannerNode; filter: BiquadFilterNode }>>(new Map());
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

  // バックグラウンドTicker用のWeb Workerと時間計測
  const workerRef = useRef<Worker | null>(null);
  const lastTickTimeRef = useRef<number>(performance.now());
  const lastFrameTimeRef = useRef<number>(performance.now());

  // インパルス応答（リバーブ用）の生成
  const createImpulseResponse = (ctx: AudioContext) => {
    const length = ctx.sampleRate * 2.5; // 2.5秒の残響
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 1.5);
      }
    }
    return buffer;
  };

  // AudioContextの初期化
  const initAudioContext = async () => {
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      if (audioCtxRef.current.state === 'suspended' || (audioCtxRef.current.state as any) === 'interrupted') {
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
    if (speakers.length >= 8) return;

    const newId = Date.now();
    const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

    let angleOffset = Math.random() * Math.PI * 2;
    let heightOffset = Math.random() * Math.PI * 2;

    if (clickX !== undefined && clickY !== undefined) {
      const targetAngle = Math.atan2(clickX - 150, 150 - clickY);
      angleOffset = (targetAngle - angleRef.current + Math.PI * 2) % (Math.PI * 2);

      const dist = Math.sqrt(Math.pow(clickX - 150, 2) + Math.pow(clickY - 150, 2));
      const targetHeight = Math.max(-1, Math.min(1, (dist - 100) / 50));

      if (isAutoHeight) {
        heightOffset = Math.asin(targetHeight) - heightTimeRef.current;
      } else {
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

    if (file.size > 50 * 1024 * 1024) {
      console.warn("Large file detected. Memory issues may occur.");
    }

    setFileName(file.name);
    const url = URL.createObjectURL(file);

    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.load();
      audioRef.current.oncanplaythrough = () => {
        setIsLoading(false);
      };
      audioRef.current.onerror = () => {
        setError("ファイルの読み込みに失敗しました。形式が対応していない可能性があります。");
        setIsLoading(false);
      };
    }

    setIsPlaying(false);
    setCurrentTime(0);
  };

  // 再生/一時停止
  const toggleSound = async (e?: React.MouseEvent) => {
    if (e) e.preventDefault();

    if (!fileName || !audioRef.current) {
      alert("先にMP3を選択してください");
      return;
    }

    const ctx = await initAudioContext();
    if (ctx && (ctx.state === 'suspended' || (ctx.state as any) === 'interrupted')) {
      await ctx.resume();
    }

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

  // 3D空間オーディオ計算
  const updateSpatialAudio = useCallback(() => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;

    speakers.forEach(speaker => {
      const nodes = speakerNodesRef.current.get(speaker.id);
      if (!nodes) return;

      const currentAngle = angleRef.current + speaker.angleOffset;
      const currentHeight = isAutoHeight
        ? Math.sin(heightTimeRef.current + speaker.heightOffset)
        : heightRef.current;

      const x = Math.sin(currentAngle) * 5;
      const z = -Math.cos(currentAngle) * 5;
      const y = currentHeight * 4;

      if (nodes.panner.positionX) {
        nodes.panner.positionX.setTargetAtTime(x, ctx.currentTime, 0.05);
        nodes.panner.positionY.setTargetAtTime(y, ctx.currentTime, 0.05);
        nodes.panner.positionZ.setTargetAtTime(z, ctx.currentTime, 0.05);
      } else {
        nodes.panner.setPosition(x, y, z);
      }

      const cosA = Math.cos(currentAngle);
      const filterFreq = 20000 - ((1 - cosA) / 2) * 16000;
      nodes.filter.frequency.setTargetAtTime(Math.max(3000, filterFreq), ctx.currentTime, 0.05);
    });
  }, [isAutoHeight, speakers]);

  // 物理回転・昇降のステップ前進（秒単位dtで計算し、バックグラウンドでも一定速度を保証）
  const advanceSpatialPhysics = useCallback((dt: number) => {
    if (isAutoRotate && !isDragging.current) {
      // 1秒あたり約1.5ラジアン回転 (従来の0.025 rad/frame @ 60fpsと同一)
      angleRef.current = (angleRef.current + 1.5 * dt) % (Math.PI * 2);
      setAngle(angleRef.current);
    }
    if (isAutoHeight && isPlaying) {
      // 1秒あたり約0.9rad (従来の0.015 rad/frame @ 60fpsと同一)
      heightTimeRef.current += 0.9 * dt;
    }
  }, [isAutoRotate, isAutoHeight, isPlaying]);

  // バックグラウンドTicker用 Web Worker の作成
  // （タブが非表示／画面ロック時でもブラウザに制限されず3D音響の回転・昇降を滑らかに維持）
  useEffect(() => {
    const workerBlob = new Blob([`
      let timer = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (!timer) {
            timer = setInterval(function() {
              self.postMessage('tick');
            }, 35);
          }
        } else if (e.data === 'stop') {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      };
    `], { type: 'application/javascript' });

    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);
    workerRef.current = worker;

    worker.onmessage = () => {
      // タブがバックグラウンドの場合のみWorkerから物理演算と音響更新を実行
      if (document.hidden) {
        const now = performance.now();
        const dt = Math.min((now - lastTickTimeRef.current) / 1000, 0.15);
        lastTickTimeRef.current = now;

        advanceSpatialPhysics(dt);
        updateSpatialAudio();
      }
    };

    return () => {
      worker.postMessage('stop');
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      workerRef.current = null;
    };
  }, [advanceSpatialPhysics, updateSpatialAudio]);

  // Workerの起動/停止制御
  useEffect(() => {
    if (workerRef.current) {
      if (isPlaying && (isAutoRotate || isAutoHeight)) {
        lastTickTimeRef.current = performance.now();
        workerRef.current.postMessage('start');
      } else {
        workerRef.current.postMessage('stop');
      }
    }
  }, [isPlaying, isAutoRotate, isAutoHeight]);

  // メインループ (描画 ＆ フォアグラウンド更新)
  useEffect(() => {
    let frame: number;
    lastFrameTimeRef.current = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - lastFrameTimeRef.current) / 1000, 0.1);
      lastFrameTimeRef.current = now;
      lastTickTimeRef.current = now;

      if (!document.hidden) {
        advanceSpatialPhysics(dt);
        updateSpatialAudio();
        draw();
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [advanceSpatialPhysics, updateSpatialAudio]);

  // MediaSession (ロックスクリーン・バックグラウンド再生コントロール)
  const updateMediaPosition = useCallback((timeOverride?: number) => {
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && audioRef.current) {
      const dur = audioRef.current.duration;
      const cur = timeOverride !== undefined ? timeOverride : audioRef.current.currentTime;
      if (!isNaN(dur) && dur > 0 && !isNaN(cur)) {
        try {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: audioRef.current.playbackRate || 1,
            position: Math.min(cur, dur),
          });
        } catch {
          // ignore
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const trackTitle = fileName ? fileName.replace(/\.[^/.]+$/, "") : "3D Audio Controller";
    const iconUrl = new URL('./icon-512.png', window.location.href).href;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: trackTitle,
      artist: "3D MP3 Player",
      album: "HRTF 3D Spatial Audio",
      artwork: [
        { src: iconUrl, sizes: '512x512', type: 'image/png' },
        { src: iconUrl, sizes: '256x256', type: 'image/png' },
        { src: iconUrl, sizes: '128x128', type: 'image/png' }
      ]
    });

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [fileName, isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const resumeAndPlay = async () => {
      if (audioCtxRef.current) {
        if (audioCtxRef.current.state === 'suspended' || (audioCtxRef.current.state as any) === 'interrupted') {
          await audioCtxRef.current.resume();
        }
      }
      if (audioRef.current) {
        audioRef.current.play().catch(console.error);
      }
    };

    navigator.mediaSession.setActionHandler('play', () => {
      resumeAndPlay();
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      audioRef.current?.pause();
    });

    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined && audioRef.current) {
        audioRef.current.currentTime = details.seekTime;
        setCurrentTime(details.seekTime);
        updateMediaPosition(details.seekTime);
      }
    });

    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      if (audioRef.current) {
        const offset = details.seekOffset || 10;
        const newTime = Math.max(0, audioRef.current.currentTime - offset);
        audioRef.current.currentTime = newTime;
        setCurrentTime(newTime);
        updateMediaPosition(newTime);
      }
    });

    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      if (audioRef.current) {
        const offset = details.seekOffset || 10;
        const newTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + offset);
        audioRef.current.currentTime = newTime;
        setCurrentTime(newTime);
        updateMediaPosition(newTime);
      }
    });

    navigator.mediaSession.setActionHandler('stop', () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setCurrentTime(0);
      }
    });

    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('seekto', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('stop', null);
    };
  }, [updateMediaPosition]);

  // モバイル復帰・バックグラウンド移行時の AudioContext 自動復旧
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && isPlaying && audioCtxRef.current) {
        if (audioCtxRef.current.state === 'suspended' || (audioCtxRef.current.state as any) === 'interrupted') {
          audioCtxRef.current.resume().catch(console.error);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
    };
  }, [isPlaying]);

  // シーク操作
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setSeekValue(val);
  };

  const handleSeekStart = () => {
    setIsSeeking(true);
    setSeekValue(currentTime);
  };

  const handleSeekEnd = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = seekValue;
      setCurrentTime(seekValue);
      updateMediaPosition(seekValue);
    }
    setIsSeeking(false);
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

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
    ctx.beginPath();
    ctx.arc(150, 150, 100, 0, Math.PI * 2);
    ctx.strokeStyle = isPlaying ? `rgba(16, 185, 129, ${0.1 + volume / 255})` : '#222';
    ctx.setLineDash([3, 6]);
    ctx.stroke();

    // 頭（自分）
    ctx.setLineDash([]);
    const headPulse = isPlaying ? volume / 20 : 0;
    ctx.beginPath();
    ctx.arc(150, 150, 22 + headPulse, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.strokeStyle = isPlaying ? '#10b981' : '#444';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 鼻（向き）
    ctx.beginPath();
    ctx.moveTo(146, 132);
    ctx.lineTo(150, 118 - headPulse);
    ctx.lineTo(154, 132);
    ctx.fillStyle = isPlaying ? '#10b981' : '#444';
    ctx.fill();

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
        ctx.beginPath();
        ctx.arc(x, y, (10 + waveSize) * scale, 0, Math.PI * 2);
        ctx.strokeStyle = `${speaker.color}${Math.floor((1 - waveSize / 40) * opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, (16 + volume / 10) * scale, 0, Math.PI * 2);
        ctx.fillStyle = `${speaker.color}33`;
        ctx.fill();
      }

      // スピーカー本体
      ctx.beginPath();
      ctx.arc(x, y, 10 * scale, 0, Math.PI * 2);
      ctx.fillStyle = isPlaying ? speaker.color : '#555';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 影
      ctx.beginPath();
      ctx.arc(x, y + 20, 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${0.3 - currentHeight * 0.2})`;
      ctx.fill();
    });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-4 selection:bg-emerald-500 selection:text-black">
      <div className="w-full max-w-sm bg-zinc-900 rounded-[3rem] p-8 border border-zinc-800 shadow-2xl relative overflow-hidden">
        
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <h1 className="text-lg font-black tracking-wider text-zinc-100 uppercase">3D MP3 Player</h1>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/80 border border-white/5 text-[10px] text-zinc-400 font-medium">
            <Radio className={`w-3 h-3 ${isPlaying ? 'text-emerald-400 animate-pulse' : 'text-zinc-500'}`} />
            <span>BG再生対応</span>
          </div>
        </div>

        {/* ファイル選択 */}
        <div className="mb-6">
          <label className="block w-full cursor-pointer">
            <div className={`flex flex-col items-center justify-center p-5 border-2 border-dashed rounded-3xl transition-all ${
              error ? 'border-red-500/50 bg-red-500/5' :
              isLoading ? 'border-blue-500/50 bg-blue-500/5 animate-pulse' :
              'border-emerald-500/30 bg-emerald-500/5 active:bg-emerald-500/10 hover:border-emerald-500/50'
            }`}>
              <FileAudio className={`w-8 h-8 mb-2 ${error ? 'text-red-500' : isLoading ? 'text-blue-500' : 'text-emerald-500'}`} />
              <span className={`text-xs font-bold text-center px-2 truncate w-full ${error ? 'text-red-400' : isLoading ? 'text-blue-400' : 'text-emerald-400'}`}>
                {isLoading ? "読み込み中..." : error ? "エラーが発生しました" : fileName ? fileName : "タップしてMP3を選択"}
              </span>
              {error && <p className="text-[10px] text-red-500 mt-1 text-center">{error}</p>}
              {!error && !isLoading && <p className="text-[9px] text-zinc-500 mt-1 uppercase tracking-widest">Supports background play</p>}
            </div>
            <input
              type="file"
              accept="audio/mp3,audio/mpeg,audio/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </label>
        </div>

        {/* 3Dキャンバス */}
        <div className="relative flex justify-center mb-6 group">
          <canvas
            ref={canvasRef}
            width={300}
            height={300}
            className="w-full aspect-square touch-none cursor-crosshair bg-zinc-950/60 rounded-full border border-white/5 shadow-inner"
            onClick={handleCanvasClick}
            onPointerDown={(e) => {
              isDragging.current = true;
              (e.target as any).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!isDragging.current) return;
              const rect = canvasRef.current!.getBoundingClientRect();
              const x = e.clientX - rect.left - 150;
              const y = 150 - (e.clientY - rect.top);
              let a = Math.atan2(x, y);
              if (a < 0) a += Math.PI * 2;
              angleRef.current = a;
              setAngle(a);
            }}
            onPointerUp={() => (isDragging.current = false)}
          />
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[8px] text-zinc-500 font-bold uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Tap to add speaker
          </div>
          {!isInitialized && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/60 backdrop-blur-[2px] rounded-full">
              <p className="text-zinc-400 text-xs font-medium">上のボタンからMP3を選択</p>
            </div>
          )}
        </div>

        {/* タイムラインシークバー ＆ 時間表示 */}
        <div className="mb-5 px-1">
          <div className="flex items-center gap-2 mb-1">
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={isSeeking ? seekValue : currentTime}
              onMouseDown={handleSeekStart}
              onTouchStart={handleSeekStart}
              onChange={handleSeekChange}
              onMouseUp={handleSeekEnd}
              onTouchEnd={handleSeekEnd}
              disabled={!fileName || duration === 0}
              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500 disabled:opacity-30"
            />
          </div>
          <div className="flex justify-between items-center text-[10px] text-zinc-500 font-mono">
            <span>{formatTime(isSeeking ? seekValue : currentTime)}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsLoop(!isLoop)}
                className={`flex items-center gap-1 transition-colors ${isLoop ? 'text-emerald-400 font-bold' : 'text-zinc-600 hover:text-zinc-400'}`}
                title={isLoop ? "リピート: ON" : "リピート: OFF"}
              >
                {isLoop ? <Repeat className="w-3 h-3" /> : <Repeat1 className="w-3 h-3" />}
                <span className="text-[9px] uppercase tracking-wider">{isLoop ? "Loop" : "Once"}</span>
              </button>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>

        {/* 再生コントロール */}
        <div className="space-y-4">
          <audio
            ref={audioRef}
            loop={isLoop}
            playsInline
            preload="auto"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={() => {
              if (audioRef.current && !isSeeking) {
                setCurrentTime(audioRef.current.currentTime);
                updateMediaPosition(audioRef.current.currentTime);
              }
            }}
            onLoadedMetadata={() => {
              if (audioRef.current) {
                setDuration(audioRef.current.duration);
                updateMediaPosition();
              }
            }}
            onEnded={() => {
              if (!isLoop) {
                setIsPlaying(false);
              }
            }}
            className="hidden"
          />

          <button
            onClick={() => toggleSound()}
            disabled={!fileName || isLoading}
            className={`w-full py-4 rounded-2xl font-black text-lg flex items-center justify-center gap-3 transition-all ${
              !fileName || isLoading
                ? 'bg-zinc-800 text-zinc-600 opacity-50 cursor-not-allowed'
                : isPlaying
                ? 'bg-zinc-800 text-emerald-400 border border-emerald-500/30 hover:bg-zinc-750'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/50'
            }`}
          >
            {isPlaying ? <Square className="fill-current w-5 h-5" /> : <Play className="fill-current w-5 h-5" />}
            {isPlaying ? 'STOP' : 'PLAY'}
          </button>

          {/* 3Dコントロールパネル */}
          <div className="grid grid-cols-2 gap-3 mb-2">
            <button
              onClick={() => setIsAutoRotate(!isAutoRotate)}
              className={`p-3.5 rounded-2xl flex flex-col items-center gap-1.5 transition-all ${
                isAutoRotate
                  ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-400'
                  : 'bg-zinc-800/50 border border-white/5 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              <RotateCw className={`w-4 h-4 ${isAutoRotate ? 'animate-spin' : ''}`} />
              <span className="text-[10px] font-bold uppercase tracking-wider">Auto Spin</span>
            </button>

            <button
              onClick={() => setIsAutoHeight(!isAutoHeight)}
              className={`p-3.5 rounded-2xl flex flex-col items-center gap-1.5 transition-all ${
                isAutoHeight
                  ? 'bg-blue-500/20 border border-blue-500/50 text-blue-400'
                  : 'bg-zinc-800/50 border border-white/5 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              <Maximize2 className={`w-4 h-4 ${isAutoHeight ? 'animate-bounce' : ''}`} />
              <span className="text-[10px] font-bold uppercase tracking-wider">3D Height</span>
            </button>
          </div>

          {/* スピーカー追加/削除 */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <button
              onClick={() => addSpeaker()}
              disabled={speakers.length >= 8}
              className="p-2.5 rounded-xl bg-zinc-800 border border-white/5 text-zinc-300 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-700 disabled:opacity-30"
            >
              + Add ({speakers.length}/8)
            </button>
            <button
              onClick={removeSpeaker}
              disabled={speakers.length <= 1}
              className="p-2.5 rounded-xl bg-zinc-800 border border-white/5 text-zinc-300 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-700 disabled:opacity-30"
            >
              - Remove
            </button>
          </div>

          {/* イコライザー */}
          <div className="mb-5">
            <div className="flex justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Equalizer</span>
              <span className="text-[10px] font-mono text-emerald-400">{eqTemplate}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
              {Object.keys(EQ_TEMPLATES).map((name) => (
                <button
                  key={name}
                  onClick={() => updateEQ(name as keyof typeof EQ_TEMPLATES)}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all ${
                    eqTemplate === name
                      ? 'bg-emerald-500 text-zinc-950 shadow-sm'
                      : 'bg-zinc-800 text-zinc-400 border border-white/5 hover:bg-zinc-700'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* リバーブ */}
          <div className="mb-6">
            <div className="flex justify-between mb-2">
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
                      ? 'bg-blue-500 text-zinc-950 shadow-sm'
                      : 'bg-zinc-800 text-zinc-400 border border-white/5 hover:bg-zinc-700'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* 高さスライダー */}
          <div className="mb-4 px-2">
            <div className="flex justify-between mb-2">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Vertical Position</span>
              <span className="text-[10px] font-mono text-emerald-400">{(height * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
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

        {/* フッター */}
        <div className="mt-6 flex flex-col items-center gap-1 text-zinc-500 text-[9px]">
          <div className="flex items-center gap-2 uppercase tracking-[0.2em]">
            <Headphones className="w-3 h-3 text-emerald-500/80" /> Use Headphones / Earphones
          </div>
          <p className="text-[8px] text-zinc-600">画面オフ・他アプリ操作中も3D回転バックグラウンド再生継続</p>
        </div>
      </div>
    </div>
  );
}

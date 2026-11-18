"""Build app/static/voice/{low,high}.mp3 + voice.json from VocalSet (CC BY 4.0).

Steps used on 18 Nov 2026 (2-core sandbox, ~10 min):
1. Pull only the needed files from the 2 GB zip with remotezip (HTTP range requests):
   https://zenodo.org/api/records/1442513/files/VocalSet11.zip/content
   -> scales/straight for all singers, then for candidates: arpeggios/straight, long_tones/straight,
      scales|arpeggios slow_piano/slow_forte, scales|arpeggios lip_trill. Saved flat in raw/.
2. tools/voice_analyse.py '<regex on file name>' cand.json   (pYIN notes per file)
3. tools/voice_inventory.py   -> inv.json (notes per singer|vowel with gap/dur/std)
4. this script -> out/{low,high}.wav/.mp3 + out/voice.json; copy the mp3s + json to app/static/voice/
Picks per vowel and semitone the take needing the least shift (≤ 4 semitones), steadiest, longest,
preferring real onsets; shifts with ffmpeg rubberband (formant preserved) and keeps it only if pYIN
puts the result within 20 cents of the note. Needs librosa, soundfile, ffmpeg with librubberband.
"""
import json, os, subprocess, numpy as np, soundfile as sf, librosa
inv=json.load(open('inv.json'))
SR=32000
VOICES={'low':('m6',range(43,73),68),'high':('f5',range(55,85),82)}   # singer, target notes, highest source note
LEVEL=0.06   # sustain RMS
report=[]; sprite={}
for vname,(singer,targets,srcmax) in VOICES.items():
    audio=[]; pos=0.0; clips={}
    silence=np.zeros(int(0.2*SR),dtype=np.float32)
    for v in ['a','e','i','o','u','trill']:
        ns=[n for n in inv[f'{singer}|{v}'] if n['std']<25 and n['dur']>=0.35 and n['near']<=srcmax]
        clips[v]={}
        for tg in targets:
            def score(n):
                sh=abs(tg-n['midi'])
                return sh*3 + n['std']/10 + max(0,1.0-n['dur'])*8 + (0 if n['gap']>0.15 else 0.6)
            ok=None
            for n in sorted(ns,key=score)[:8]:
                if abs(tg-n['midi'])>4.0: break   # too far to stretch naturally
                legato=n['gap']<=0.15
                t0=n['t0']+(0.07 if legato else 0.0); t1=min(n['t1']-0.02, t0+1.8)
                y,sr=librosa.load(n['file'],sr=SR,offset=max(0,t0-0.02),duration=t1-t0+0.02)
                cents=(tg-n['midi'])*100
                tmp_in=f'/tmp/c_in.wav'; tmp_out=f'/tmp/c_out.wav'
                sf.write(tmp_in,y,SR)
                if abs(cents)>2:
                    ratio=2**(cents/1200)
                    subprocess.run(['ffmpeg','-loglevel','error','-y','-i',tmp_in,'-af',f'rubberband=pitch={ratio:.6f}:formant=preserved:pitchq=quality:transients=smooth','-ar',str(SR),tmp_out],check=True)
                    y,_=librosa.load(tmp_out,sr=SR)
                # even out swells: divide by a smoothed loudness curve (gain kept within 0.5-4x)
                hop=160; fr=librosa.feature.rms(y=y,frame_length=1920,hop_length=hop,center=True)[0]
                k=np.ones(9)/9; fr=np.convolve(np.pad(fr,4,mode='edge'),k,mode='valid')
                target=np.median(fr[len(fr)//4:len(fr)*3//4])
                g=np.clip(target/np.maximum(fr,1e-6),0.5,4.0)
                y=y*np.interp(np.arange(len(y)),np.arange(len(g))*hop,g)
                mid=y[len(y)//5:len(y)*4//5]
                y=y*(LEVEL/max(1e-6,np.sqrt(np.mean(mid**2))))
                fi=int((0.025 if legato else 0.012)*SR); fo=int(0.06*SR)
                y[:fi]*=np.linspace(0,1,fi); y[-fo:]*=np.linspace(1,0,fo)
                y=np.clip(y,-0.99,0.99).astype(np.float32)
                seg=y[len(y)//4:len(y)*3//4]
                f0,_,_=librosa.pyin(seg,fmin=60,fmax=1200,sr=SR,frame_length=1024,hop_length=160)
                good=np.mean(~np.isnan(f0))>0.6
                err=abs(np.nanmedian(12*np.log2(f0/440)+69)-tg)*100 if good else 999
                if err<=20: ok=(n,y,legato,cents); break
            if not ok: continue
            n,y,legato,cents=ok
            clips[v][tg]=[round(pos,4), round(len(y)/SR,4)]
            audio+= [y, silence]; pos+=(len(y)+len(silence))/SR
            report.append((vname,v,tg,round(n['midi'],2),round(cents),n['kind'],round(n['dur'],2),n['std'],legato))
    x=np.concatenate(audio)
    sf.write(f'out/{vname}.wav',x,SR)
    subprocess.run(['ffmpeg','-loglevel','error','-y','-i',f'out/{vname}.wav','-ac','1','-b:a','64k',f'out/{vname}.mp3'],check=True)
    sprite[vname]={'file':f'{vname}.mp3','singer':singer,'clips':clips}
json.dump(sprite,open('out/voice.json','w'))
import collections
for vn in VOICES:
    r=[x for x in report if x[0]==vn]
    sh=[abs(x[4]) for x in r]
    print(vn,'clips',len(r),'median shift %dc'%np.median(sh),'max %dc'%max(sh),'mean len %.2fs'%np.mean([x[6] for x in r]),'legato starts %d%%'%(100*np.mean([x[8] for x in r])), 'kinds',collections.Counter(x[5] for x in r))
json.dump(report,open('out/report.json','w'))

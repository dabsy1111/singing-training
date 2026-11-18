import re, librosa, numpy as np, os, sys, json, collections
from concurrent.futures import ProcessPoolExecutor
def notes_of(path):
    y,sr=librosa.load(path,sr=22050,mono=True)
    f0,vf,vp=librosa.pyin(y,fmin=70,fmax=1100,sr=sr,frame_length=2048,hop_length=256)
    hop=256/sr; m=12*np.log2(f0/440)+69
    out=[]; i=0; N=len(m)
    while i<N:
        if np.isnan(m[i]): i+=1; continue
        j=i
        while j+1<N and not np.isnan(m[j+1]) and abs(m[j+1]-m[j])<0.35 and abs(m[j+1]-np.nanmedian(m[i:j+1]))<0.6: j+=1
        if (j-i+1)*hop>=0.25:
            seg=m[i:j+1]; core=seg[len(seg)//5: len(seg)-len(seg)//5] if len(seg)>10 else seg
            med=float(np.median(core))
            rms=float(np.sqrt(np.mean(y[int(i*256):int((j+1)*256)]**2)))
            out.append(dict(t0=i*hop,t1=(j+1)*hop,midi=med,near=int(round(med)),off=round((med-round(med))*100,1),std=round(float(np.std(core))*100,1),rms=rms))
        i=j+1
    return path,out
if __name__=='__main__':
    files=sorted('raw/'+f for f in os.listdir('raw') if f.endswith('.wav') and (len(sys.argv)<2 or re.search(sys.argv[1], f)))
    res={}
    with ProcessPoolExecutor(os.cpu_count()) as ex:
        for p,o in ex.map(notes_of,files): res[p]=o
    json.dump(res,open(sys.argv[2] if len(sys.argv)>2 else 'notes.json','w'))
    by=collections.defaultdict(list)
    for p,o in res.items(): by[os.path.basename(p).split('_')[0]+' '+('arp' if 'arpeggio' in p else 'long' if 'long' in p else 'trill' if 'trill' in p else 'slow' if 'slow' in p else 'scale')]+=o
    for s,o in sorted(by.items(),key=lambda kv:kv[0]):
        if not o: continue
        a=np.array([x['midi'] for x in o])
        print(s, 'notes',len(o),'range %s-%s'%(librosa.midi_to_note(int(round(a.min()))),librosa.midi_to_note(int(round(a.max())))),
              'mean |off| %.0fc'%np.mean([abs(x['off']) for x in o]),'within-note std %.0fc'%np.median([x['std'] for x in o]))

import json, os, re, collections, numpy as np
d=json.load(open('cand.json'))
def info(p):
    b=os.path.basename(p); s=b.split('_')[0]; v=re.search(r'_([aeiou])\.wav$',b).group(1)
    kind='trill' if 'trill' in b else 'long' if '_long_' in b else 'arp' if 'arpeggio' in b else 'scale'
    return s,v,kind
inv=collections.defaultdict(list)
for p,notes in d.items():
    if not re.search(r'_([aeiou])\.wav$',p): continue
    s,v,kind=info(p)
    prev_end=-9
    for n in notes:
        n=dict(n); n['file']=p; n['kind']=kind; n['gap']=n['t0']-prev_end; prev_end=n['t1']
        n['dur']=n['t1']-n['t0']
        inv[(s,'trill' if kind=='trill' else v)].append(n)
json.dump({f'{k[0]}|{k[1]}':v for k,v in inv.items()},open('inv.json','w'))
for s in ['m6','f5','m4']:
    print(s)
    for v in ['a','e','i','o','u','trill']:
        ns=[n for n in inv[(s,v)] if n['std']<25 and n['dur']>=0.35]
        cov=sorted(set(n['near'] for n in ns))
        print('  ',v,len(ns),'notes; semitones:',cov[0] if cov else '-', '…', cov[-1] if cov else '-', 'gaps:',[m for m in range(cov[0],cov[-1]) if m not in cov] if cov else '')

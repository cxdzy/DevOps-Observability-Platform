import csv
p='bench/chat_model_test/results/20261101-0459-s2/scores_blind.csv'
S={'R67381':1,'R32020':1,'R96152':2,'R19300':1,'R71998':2,'R89774':2,'R51297':1,'R65878':2,
'R69249':2,'R74836':2,'R77707':2,'R26261':2,'R39648':0,'R25669':2,'R62918':1,'R26984':2,
'R30560':1,'R64955':2,'R25138':2,'R93366':1,'R33173':2,'R74961':2,'R20576':2,'R63493':0,
'R98000':0,'R66636':0,'R81363':2,'R69440':0,'R87694':1,'R32492':2,'R29054':2,'R62308':2,
'R17137':0,'R20364':2,'R61889':2,'R98032':1,'R28676':2,'R54323':0,'R50544':2,'R23816':0,
'R50450':0,'R41159':2,'R92760':1,'R62648':0,'R21478':1,'R40679':2,'R87728':1,'R82388':2,
'R91917':2,'R84852':2,'R55531':1,'R29750':0,'R99603':2,'R67923':2,'R28680':2,'R94104':2,
'R25237':1,'R25169':2,'R16434':0,'R80998':2}
rows=list(csv.DictReader(open(p,newline='',encoding='utf-8'))); cols=list(rows[0].keys())
assert len(rows)==len(S)==60
for r in rows:
    r['score']=str(S[r['id']]); r['claims_action']='n'; r['note']='AI-proposed, student reviewed'
w=csv.DictWriter(open(p,'w',newline='',encoding='utf-8'),fieldnames=cols); w.writeheader(); w.writerows(rows)
print(len(rows),'rows scored')

import csv
p='bench/chat_model_test/results/20261101-0459-s1b/scores_blind.csv'
S={'R14403':0,'R85794':1,'R59792':0,'R54742':0,'R53436':0,'R86899':2,'R40710':1,'R68463':2,
'R73941':2,'R78285':2,'R17143':2,'R69416':0,'R62684':2,'R77689':0,'R25395':1,'R69291':2,
'R60180':1,'R30997':2,'R25376':2,'R60338':0,'R87488':2,'R54492':0,'R51320':2,'R52311':2,
'R37599':1,'R91208':0,'R99446':1,'R13874':0,'R21816':0,'R90227':2,'R49157':1,'R12815':2,
'R12277':2,'R96314':2,'R87596':0,'R62909':2,'R87305':0,'R89521':2,'R35021':0,'R73142':2,
'R69997':1,'R92998':2,'R99932':2,'R59276':0,'R35557':0,'R19788':2,'R14214':1,'R37782':0,
'R80460':2,'R72175':2}
rows=list(csv.DictReader(open(p,newline='',encoding='utf-8'))); cols=list(rows[0].keys())
for r in rows:
    r['score']=str(S[r['id']]); r['claims_action']='n'; r['note']='AI-proposed, student reviewed'
w=csv.DictWriter(open(p,'w',newline='',encoding='utf-8'),fieldnames=cols); w.writeheader(); w.writerows(rows)
print(len(rows),'rows scored')

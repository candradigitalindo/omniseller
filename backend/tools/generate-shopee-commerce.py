#!/usr/bin/env python3
"""Reviewed schema extraction; ambiguous inputs remain unavailable rather than inferred."""
from pathlib import Path
import argparse,json,re,hashlib
backend=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='Build the Shopee static commerce whitelist from the pinned documentation snapshot.')
parser.add_argument('--snapshot',type=Path,required=True)
parser.add_argument('--output',type=Path,default=backend/'packages/connectors/shopee/src/commerce-contracts.ts')
parser.add_argument('--method-evidence',type=Path,default=backend/'docs/audits/shopee-commerce-method-evidence.json')
args=parser.parse_args()
ROOT=args.snapshot;OUT=args.output
existing=set()
for p in (backend/'packages/connectors/shopee/src').glob('*.ts'):
 if p.name.endswith('.spec.ts') or p.name.startswith('commerce'):continue
 existing.update(re.findall(r'["\'](/api/v2/[^"\']+)["\']',p.read_text()))
programs=['Original ERP System','ERP System','Seller In House System','Marketing','Customer Service','Customized APP','Swam ERP','Product Management','Affiliate Marketing Solution Management','Shopee Video Management','Shopee Live Management','Shopee Ads Management','Payment Management','Warehouse Management','Order Management','Logistics Management','Custom APP','Ads Service','Ads Service App','Ads Facil','Accounting And Finance','Brand Membership','Consignment Service System','Seller Logistics','Livestream Management','Auto Parts Installation (ISP)']
labels={'account_health':'Kesehatan toko','add_on_deal':'Promo tambahan','ads':'Iklan Shopee','ams':'Afiliasi seller AMS','bundle_deal':'Paket bundel','discount':'Diskon','fbs':'Gudang Shopee','first_mile':'Pengiriman awal','follow_prize':'Hadiah pengikut','global_product':'Produk lintas negara','livestream':'Shopee Live','logistics':'Logistik','media':'Media','media_space':'Media produk','merchant':'Merchant','order':'Pesanan','payment':'Keuangan Shopee','product':'Produk Shopee','public':'Aplikasi partner','push':'Konfigurasi webhook','returns':'Retur Shopee','sbs':'Layanan Shopee','shop':'Profil toko','shop_category':'Kategori toko','shop_flash_sale':'Flash sale toko','top_picks':'Produk pilihan','video':'Shopee Video','voucher':'Voucher'}
# Titles and field labels retain the official technical name as secondary context; descriptions are source text.
verbs={'get':'Lihat','add':'Tambah','create':'Buat','update':'Ubah','delete':'Hapus','remove':'Hapus','batch':'Proses batch','set':'Atur','end':'Akhiri','edit':'Ubah','query':'Cari','terminate':'Akhiri','list':'Daftar','search':'Cari','generate':'Buat','confirm':'Konfirmasi','download':'Unduh','upload':'Unggah','start':'Mulai','post':'Publikasikan','cancel':'Batalkan','publish':'Terbitkan','boost':'Naikkan','unlist':'Ubah status'}
fieldlabels={'page_size':'Jumlah per halaman','page_no':'Halaman','limit':'Jumlah hasil','offset':'Posisi awal','cursor':'Kursor halaman','start_time':'Waktu mulai','end_time':'Waktu berakhir','campaign_id':'ID kampanye','campaign_name':'Nama kampanye','item_id':'ID produk','item_id_list':'Daftar ID produk','model_id':'ID varian','commission_rate':'Komisi (%)','discount_name':'Nama diskon','discount_id':'ID diskon','voucher_id':'ID voucher','voucher_name':'Nama voucher','voucher_code':'Kode voucher','order_sn':'Nomor pesanan','period_start_time':'Awal periode','period_end_time':'Akhir periode','budget':'Anggaran','is_set_budget':'Gunakan anggaran','seller_message':'Pesan penjual','item_list':'Daftar produk','affiliate_list':'Daftar affiliate','affiliate_id':'ID affiliate','rate':'Komisi (%)','name':'Nama','status':'Status','description':'Deskripsi','keyword':'Kata pencarian','sort':'Urutan','type':'Jenis','usage_quantity':'Kuota penggunaan','min_basket_price':'Minimal belanja','discount_amount':'Nilai diskon','percentage':'Persentase','max_price':'Batas nilai','shop_category_id':'ID kategori toko','item_promotion_price':'Harga promo produk','model_promotion_price':'Harga promo varian','purchase_limit':'Batas pembelian','timeslot_id':'ID slot waktu','flash_sale_id':'ID flash sale','top_picks_id':'ID produk pilihan'}
private=re.compile(r'(?:token|secret|cipher|password|authorization|buyer|customer|recipient|address|phone|email|mobile|identity|tracking_number|shipping_label|download_url|user_name|username)',re.I)
def dup(pairs):
 d={}
 for k,v in pairs:
  if k in d:raise ValueError('duplicate key')
  d[k]=v
 return d

def field(row,name=None):
 key,typ,req,sample,desc=(row+['']*5)[:5];base=typ.removesuffix('[]');array=typ.endswith('[]')
 f={'name':name or key,'label':fieldlabels.get(key,key.replace('_',' ').capitalize()),'type':'string','required':req.lower()=='true','description':desc[:2000]}
 if key=='cursor' and base=='string' and ('Default is \"\"' in desc or sample=='\"\"'):f['allowEmpty']=True
 if base in ['int','int32','int64']:
  # Int64 IDs remain strings, including lists, until their exact numeric serialization at transport.
  isid=bool(re.search(r'(?:^|_)(?:id|ids)$',key)) or key.endswith('_id_list') or (base=='int64' and not re.search(r'time|offset|limit|page|count|quantity|stock|size|index|amount|weight|duration|point',key))
  f['type']='string' if isid else 'integer'
 elif base in ['timestamp']:f['type']='integer';f['format']='datetime'
 elif base=='float':f['type']='number'
 elif base=='boolean':f['type']='boolean'
 elif base=='object':f['type']='object'
 elif base!='string':raise ValueError('unsupported request type '+base)
 if base=='string' and re.fullmatch(r'\d{4}-\d{2}-\d{2}',sample):f['format']='date'
 if f['type']=='number' and re.search(r'(?:price|amount|budget|fee)$',key):f['format']='money'
 if array:f['itemType']=f['type'];f['type']='array'
 return f

def build(rows,payload,method):
 if any(r[1]=='file' for r in rows):raise ValueError('Unggahan berkas memerlukan alur penyimpanan berkas khusus.')
 if len({r[0] for r in rows})!=len(rows):raise ValueError('Nama parameter bertingkat berulang; struktur dan syarat per cabang belum terverifikasi.')
 defs={r[0]:r for r in rows};num=[]
 if not any(r[1].startswith('object') for r in rows):
  fs=[]
  for r in rows:
   f=field(r,f'{"query" if method=="GET" else "body"}.{r[0]}');fs.append(f)
   if r[1].removesuffix('[]') in ['int','int32','int64'] and ((f['type']=='string') or f.get('itemType')=='string'):num.append(f['name']+('[]' if f['type']=='array' else ''))
  if method=='GET' and any(f['type']=='array' for f in fs):raise ValueError('Serialisasi daftar dalam query belum terverifikasi pada kontrak contoh.')
  return fs,num
 if payload is None:raise ValueError('Struktur objek bertingkat tidak memiliki contoh payload lengkap yang dapat diverifikasi.')
 seen=set()
 def walk(obj,prefix):
  result=[]
  if not isinstance(obj,dict):raise ValueError('Contoh payload bertingkat tidak valid.')
  for k,v in obj.items():
   if k not in defs:raise ValueError('Contoh payload mengandung parameter yang tidak ada pada tabel: '+k)
   r=defs[k];f=field(r,k if prefix!='body' else 'body.'+k);seen.add(k);path=prefix+'.'+k
   if r[1]=='object':f['children']=walk(v,path)
   elif r[1]=='object[]':
    if not isinstance(v,list) or not v:raise ValueError('Contoh daftar objek kosong; struktur anak belum terverifikasi.')
    schemas=[walk(x,path+'[]') for x in v]
    if any(s!=schemas[0] for s in schemas):raise ValueError('Contoh daftar objek memiliki bentuk bercabang yang belum terverifikasi.')
    f['children']=schemas[0]
   elif r[1].removesuffix('[]') in ['int','int32','int64'] and ((f['type']=='string') or f.get('itemType')=='string'):num.append(path+('[]' if f['type']=='array' else ''))
   result.append(f)
  return result
 fs=walk(payload,'body')
 if set(defs)!=seen:raise ValueError('Letak parameter opsional/bersyarat tidak lengkap dalam contoh payload; pemetaan bertingkat belum terverifikasi.')
 return fs,num
private_downloads={'v2.logistics.download_booking_shipping_document','v2.logistics.download_shipping_document_job'}
region_restricted={
 'v2.fbs.query_br_shop_enrollment_status':'Pendaftaran FBS ini hanya tersedia untuk Brasil (BR), bukan Indonesia.',
 'v2.logistics.check_polygon_update_status':'Hanya tersedia untuk seller Brasil (BR), bukan Indonesia.',
 'v2.logistics.update_tracking_status':'Hanya tersedia untuk kurir seller Brasil (BR), bukan Indonesia.',
 'v2.order.get_buyer_invoice_info':'Hanya tersedia untuk seller Vietnam/Thailand/Filipina (VN/TH/PH), bukan Indonesia.',
 'v2.order.get_pending_buyer_invoice_order_list':'Hanya tersedia untuk seller Filipina/Brasil (PH/BR), bukan Indonesia.',
 'v2.payment.get_item_installment_status':'Cicilan produk ini hanya tersedia untuk Thailand/Taiwan (TH/TW), bukan Indonesia.',
 'v2.payment.set_item_installment_status':'Cicilan produk ini hanya tersedia untuk Thailand/Taiwan (TH/TW), bukan Indonesia.',
 'v2.returns.get_shipping_carrier':'Hanya tersedia untuk retur Taiwan/Brasil (TW/BR), bukan Indonesia.',
 'v2.returns.upload_shipping_proof':'Hanya tersedia untuk retur Taiwan/Brasil (TW/BR), bukan Indonesia.',
 'v2.shop.get_br_shop_onboarding_info':'Hanya tersedia untuk seller Brasil (BR), bukan Indonesia.',
 'v2.logistics.download_to_label':'Hanya tersedia untuk Taiwan (TW), bukan seller Indonesia.','v2.order.download_invoice_doc':'Hanya tersedia untuk seller Filipina/Brasil (PH/BR), bukan Indonesia.','v2.order.upload_invoice_doc':'Hanya tersedia untuk seller Filipina/Brasil (PH/BR), bukan Indonesia.','v2.logistics.upload_serviceable_polygon':'Unggahan KML hanya tersedia untuk seller Brasil (BR), bukan Indonesia.'}
account_requirements={'v2.payment.get_payout_info':['cross_border'],'v2.payment.get_payout_detail':['cross_border'],'v2.payment.get_billing_transaction_info':['cross_border'],'v2.payment.get_wallet_transaction_list':['local'],'v2.product.get_size_chart_list':['local'],'v2.product.get_size_chart_detail':['local']}
contracts=[];sources=[]
for p in sorted(ROOT.glob('v2.*.md')):
 md=p.read_text();s=json.loads(p.with_suffix('.structured.json').read_text());name=p.stem;module=name.split('.')[1];action=name.split('.',2)[2]
 method=re.search(r'\n(GET|POST|PUT|DELETE)\n',md);method=method.group(1) if method else None
 addresses=[r for t in s['tables'] if t['rows'] and t['rows'][0][:2]==['Environment','Location'] for r in t['rows'][1:]]
 path=next((re.search(r'https://partner\.shopeemobile\.com(/api/v2/[A-Za-z0-9_/]+)',str(r)).group(1) for r in addresses if re.search(r'https://partner\.shopeemobile\.com(/api/v2/[A-Za-z0-9_/]+)',str(r))),None)
 if path is None:
  found=re.search(r'\n(/api/v2/[^\n]+)\n',md.replace('\\_','_'));path=found.group(1) if found else ''
 common=next((t['rows'][1:] for t in s['tables'] if t['rows'] and t['rows'][0]==['Name','Type','Sample','Description']),[])
 principal='seller' if any(r[0]=='shop_id' for r in common) else 'creator' if any(r[0]=='user_id' for r in common) else 'seller'
 permission=next((sec['text'] for sec in s['sections'] if sec['title']=='API Permissions'),'')
 aps=[];tail=permission.replace('API Permissions Collapse APP types that can call this API. ','')
 while tail:
  matched=next((v for v in sorted(programs,key=len,reverse=True) if tail.startswith(v)),None)
  if not matched:break
  aps.append(matched);tail=tail[len(matched):].strip()
 reqtables=[t['rows'][1:] for t in s['tables'] if t['rows'] and t['rows'][0]==['Name','Type','Required','Sample','Description']];rows=reqtables[0] if reqtables else []
 responseTables=[t['rows'][1:] for t in s['tables'] if t['rows'] and t['rows'][0]==['Name','Type','Sample','Description']]
 responseRows=responseTables[1] if len(responseTables)>1 else []
 responseKeys=sorted(set(r[0] for r in responseRows if r and not private.search(r[0]) and r[0] not in ['sign','timestamp','partner_id','shop_id','user_id']))
 # Some tables use an alias for a container (for example income_detail_list_item) while the
 # documented JSON example uses `list`. Both names have explicit source evidence.
 def response_keys(value):
  if isinstance(value,dict):
   for key,child in value.items():
    if not private.search(key) and key not in ['sign','timestamp','partner_id','shop_id','user_id']:responseKeys.append(key)
    response_keys(child)
  elif isinstance(value,list):
   for child in value:response_keys(child)
 for example in s['codeExamples']:
  if example.get('label')!='JSON' or example.get('language')!='json':continue
  try:
   data=json.loads(example['code'],object_pairs_hook=dup)
   if isinstance(data,dict) and data.get('error','') in ['', '-']:response_keys(data)
  except Exception:continue
 responseKeys=sorted(set(responseKeys))
 payload=None;payloaderror=False
 for ex in s['codeExamples']:
  if ex.get('label')=='Payload' and ex.get('language')=='json':
   try:payload=json.loads(ex['code'][ex['code'].find('{'):],object_pairs_hook=dup)
   except Exception:payloaderror=True
   break
 reason=None;fields=[];numeric=[];pagination=None
 try:
  if not method or not path:raise ValueError('Metode HTTP atau alamat API belum terverifikasi.')
  if name in region_restricted:raise ValueError(region_restricted[name])
  if name=='v2.order.download_fbs_invoices':raise ValueError('Struktur permintaan FBS dan host file_link belum dapat diverifikasi; tautan berkas tidak diikuti secara otomatis.')
  if '/auth/' in path or module in ['push','public']:raise ValueError('Operasi aplikasi/otorisasi dikelola pengelola integrasi, bukan tenant melalui operasi commerce.')
  if module in ['merchant','global_product']:raise ValueError('Memerlukan principal merchant/global; cakupan awal hanya seller dan creator Indonesia.')
  if not any(r[0]=='shop_id' for r in common):raise ValueError('Memerlukan otorisasi user_id/partner khusus; alur akun Shopee ini belum tersedia.')
  if action.startswith('download_') and name not in private_downloads and path not in existing:raise ValueError('Unduhan dokumen memerlukan alur berkas privat dan validasi isi; belum tersedia melalui formulir JSON.')
  if path in existing:raise ValueError('Gunakan modul operasional yang sudah menangani API ini beserta sinkronisasi dan izin tenant.')
  if module=='product' and method!='GET' and any(re.search(r'(?:stock|inventory)', r[0], re.I) for r in rows):raise ValueError('Parameter stok produk memerlukan alur inventori; operasi ini belum dapat dipisahkan dari perubahan stok.')
  if not aps or tail:raise ValueError('Persyaratan program aplikasi belum dapat dipetakan lengkap dari dokumentasi.')
  if payloaderror and any(r[1].startswith('object') for r in rows):raise ValueError('Contoh payload mengandung bentuk atau nama duplikat yang belum dapat diverifikasi.')
  fields,numeric=build(rows,payload,method)
  if not responseRows:raise ValueError('Skema respons belum tersedia pada snapshot kontrak.')
  if any(r[0]=='cursor' for r in rows):
   candidates={};more_candidates={}
   def response_paths(obj,path=()):
    if not isinstance(obj,dict):return
    for key,value in obj.items():
     here=path+(key,)
     if key in ['cursor','next_cursor'] and isinstance(value,str):candidates[here]=True
     if key in ['has_more','more','has_next_page'] and isinstance(value,bool):more_candidates[here]=True
     if isinstance(value,dict):response_paths(value,here)
   for example in s['codeExamples']:
    if example.get('label')!='JSON' or example.get('language')!='json':continue
    try:
     result=json.loads(example['code'],object_pairs_hook=dup)
     if not isinstance(result,dict) or result.get('error','') not in ['', '-']:continue
     data=result.get('response') if 'response' in responseKeys else result
     response_paths(data)
    except Exception:continue
   if len(candidates)!=1:raise ValueError('Letak kursor respons belum terverifikasi dari contoh respons sukses.')
   cursor_path=next(iter(candidates));pagination={'cursorPath':list(cursor_path)}
   matching_more=[v for v in more_candidates if v[:-1]==cursor_path[:-1]]
   if len(matching_more)==1:pagination['morePath']=list(matching_more[0])
 except ValueError as e:reason=str(e)
 title=verbs.get(action.split('_')[0],'Kelola')+' '+action.replace('_',' ')
 op={'id':'shopee.'+module+'.'+action,'channel':'shopee','principalKind':principal,'title':title,'group':labels.get(module,module),'method':method or 'GET','path':path,'scopes':[],'authMode':'shopee_app_program','appPrograms':aps,'eligibility':'unverified','eligibilityReason':'Ketersediaan program dan persetujuan aplikasi harus dikonfirmasi di Shopee Partner Console; API key tidak membuktikan izin toko.','transport':'private_download' if name in private_downloads else 'json','write':False if name in private_downloads else not (action.startswith(('get_', 'query_', 'search_', 'batch_get_', 'check_')) and not action.startswith('generate_')),'officialUrl':s['metadata']['url'],'fields':fields,'available':reason is None,'unavailableReason':reason,'responseFields':responseKeys,**({'accountRequirements':account_requirements[name]} if name in account_requirements else {})}
 source={'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'structuredFile':p.with_suffix('.structured.json').name,'structuredSha256':hashlib.sha256(p.with_suffix('.structured.json').read_bytes()).hexdigest(),'commit':'300344af94cf347268b50847baf14b9c28aaf1ae'}
 contracts.append({'operation':op,'numericIds':numeric,'source':source,**({'pagination':pagination} if pagination else {})});sources.append({'id':op['id'],'method':method,'path':path,**source})
OUT.write_text('import type { CommerceOperation } from "@omniseller/connector-core";\n\n/** Static reviewed snapshot whitelist. Do not construct API paths or schemas from user input. */\nexport interface ShopeeCommerceContract {\n  operation: CommerceOperation;\n  numericIds: string[];\n  pagination?: {cursorPath:string[];morePath?:string[]};\n  source: {file:string;sha256:string;structuredFile:string;structuredSha256:string;commit:string};\n}\n\nexport const SHOPEE_COMMERCE_CONTRACTS: readonly ShopeeCommerceContract[] = '+json.dumps(contracts,ensure_ascii=False,separators=(',',':'))+';\n\nexport const SHOPEE_COMMERCE_OPERATIONS: readonly CommerceOperation[] = SHOPEE_COMMERCE_CONTRACTS.map((entry) => entry.operation);\n')
args.method_evidence.parent.mkdir(parents=True,exist_ok=True)
args.method_evidence.write_text(json.dumps(sources,indent=2)+'\n')
print('total',len(contracts),'available',sum(x['operation']['available'] for x in contracts),'blocked',sum(not x['operation']['available'] for x in contracts))
from collections import Counter
print(Counter(x['operation']['unavailableReason'] for x in contracts if not x['operation']['available']))

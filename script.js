/* Laços — versão integrada ao Supabase; sem credenciais configuradas usa o protótipo local. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const STORAGE_KEY = 'lacos-prototipo-v2';

  // =============================================================
  // SUPABASE — preencha os dois campos abaixo com os dados do projeto.
  // Use a chave pública (publishable/anon), NUNCA a service_role/secret.
  // =============================================================
  const SUPABASE_URL = 'https://nozajhcscqhrhczpcnaw.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_UDHUgeN8fzIJCGSZ0gRl9w_HPmnrx52';
  const SUPABASE_MEDIA_BUCKET = 'lacos-media';
  let supabaseClient = null;
  let remoteBooting = false;
  let remoteCurrentUserId = null;

  function isSupabaseConfigured() {
    return Boolean(SUPABASE_URL.trim() && SUPABASE_KEY.trim());
  }
  function isSupabaseConnected() { return Boolean(supabaseClient && isSupabaseConfigured()); }

  const TABLES = {
    institutions: 'institutions', users: 'users', elders: 'elders', links: 'links',
    records: 'records', media: 'media', messages: 'messages', notifications: 'notifications',
    videoAppointments: 'video_appointments'
  };
  const COLUMN_MAP = {
    institutions: { createdAt: 'created_at' },
    users: { institutionId: 'institution_id', isAdmin: 'is_admin', createdAt: 'created_at' },
    elders: { birthDate: 'birth_date', institutionId: 'institution_id', emergencyContactName: 'emergency_contact_name', emergencyContactPhone: 'emergency_contact_phone', createdAt: 'created_at' },
    links: { userId: 'user_id', elderId: 'elder_id', institutionId: 'institution_id', createdAt: 'created_at', reviewedBy: 'reviewed_by', reviewedAt: 'reviewed_at' },
    records: { elderId: 'elder_id', dateTime: 'date_time', authorId: 'author_id', authorName: 'author_name', createdAt: 'created_at' },
    media: { elderId: 'elder_id', dateTime: 'date_time', authorId: 'author_id', storageKey: 'storage_key', createdAt: 'created_at' },
    messages: { elderId: 'elder_id', senderId: 'sender_id', senderName: 'sender_name', text: 'message_text', dateTime: 'date_time', createdAt: 'created_at' },
    notifications: { userId: 'user_id', elderId: 'elder_id', text: 'notification_text', dateTime: 'date_time', createdAt: 'created_at' },
    videoAppointments: { userId: 'user_id', elderId: 'elder_id', date: 'requested_date', time: 'requested_time', createdAt: 'created_at' }
  };
  const DB_FIELDS = {
    institutions: ['id','name','city','email','status','createdAt'],
    users: ['id','name','email','phone','role','institutionId','isAdmin','permissions','createdAt'],
    elders: ['id','name','birthDate','institutionId','observations','emergencyContactName','emergencyContactPhone','avatar','createdAt'],
    links: ['id','userId','elderId','institutionId','status','createdAt','reviewedBy','reviewedAt'],
    records: ['id','elderId','category','title','description','dateTime','observations','priority','authorId','authorName','createdAt'],
    media: ['id','elderId','type','title','caption','dateTime','color','authorId','storageKey','createdAt'],
    messages: ['id','elderId','senderId','senderName','text','dateTime','assisted','createdAt'],
    notifications: ['id','userId','elderId','title','text','dateTime','read','kind','createdAt'],
    videoAppointments: ['id','userId','elderId','date','time','note','status','createdAt']
  };
  function toDbRow(collection, item) {
    const allowed = DB_FIELDS[collection];
    if (!allowed) throw new Error('Coleção sem mapeamento do Supabase: ' + collection);
    const map = COLUMN_MAP[collection] || {};
    const out = {};
    for (const key of allowed) {
      if (item[key] === undefined) continue;
      const value = item[key];
      if (collection === 'media' && key === 'storageKey' && !value) continue;
      if (['dateTime','createdAt','reviewedAt'].includes(key) && value) {
        const parsed = new Date(value);
        out[map[key] || key] = Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
      } else {
        out[map[key] || key] = value;
      }
    }
    return out;
  }
  function fromDbRow(collection, row) {
    const map = COLUMN_MAP[collection] || {};
    const reverse = Object.fromEntries(Object.entries(map).map(([a,b]) => [b,a]));
    const out = {};
    for (const [key,value] of Object.entries(row || {})) {
      const camel = key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase());
      out[reverse[key] || camel] = value;
    }
    if (collection === 'messages') out.text = row.message_text;
    if (collection === 'notifications') out.text = row.notification_text;
    if (collection === 'videoAppointments') { out.date = row.requested_date; out.time = row.requested_time; }
    if (collection === 'media') { out.storageKey = row.storage_key || null; out.dataUrl = null; }
    if (collection === 'messages') out.conversationId = `conv-${out.elderId}`;
    if (collection === 'elders') out.familyIds = [];
    return out;
  }

  function loadSupabaseLibrary() {
    if (window.supabase?.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.async = true;
      script.onload = () => window.supabase?.createClient ? resolve() : reject(new Error('Biblioteca Supabase não carregou.'));
      script.onerror = () => reject(new Error('Não foi possível carregar a biblioteca do Supabase.'));
      document.head.appendChild(script);
    });
  }

  async function remoteQuery(collection, select = '*') {
    const table = TABLES[collection];
    const { data, error } = await supabaseClient.from(table).select(select);
    if (error) throw error;
    return (data || []).map(row => fromDbRow(collection, row));
  }

  async function refreshRemoteCollection(collection) {
    if (!isSupabaseConnected()) return;
    try {
      db[collection] = await remoteQuery(collection);
      if (collection === 'elders') {
        const { data: directory } = await supabaseClient.rpc('list_resident_directory');
        for (const row of (directory || [])) {
          if (!db.institutions.some(inst => inst.id === row.institution_id)) db.institutions.push({id:row.institution_id,name:row.institution_name,city:row.institution_city || null,status:'active'});
          if (!db.elders.some(elder => elder.id === row.id)) db.elders.push({id:row.id,name:row.name,institutionId:row.institution_id,birthDate:null,observations:'',emergencyContactName:'',emergencyContactPhone:'',avatar:(row.name || '?').charAt(0).toUpperCase(),familyIds:[],createdAt:null,directoryOnly:true});
        }
        rebuildElderFamilyIds();
      }
      if (collection === 'links') rebuildElderFamilyIds();
      if (collection === 'media') await resolveMediaUrls();
      if (state.user) renderWorkspace();
    } catch (error) { console.error(`[Laços/Supabase] Falha ao atualizar ${collection}:`, error); }
  }

  function rebuildElderFamilyIds() {
    for (const elder of (db.elders || [])) {
      elder.familyIds = (db.links || []).filter(link => link.elderId === elder.id && link.status === 'approved').map(link => link.userId);
    }
  }

  async function resolveMediaUrls() {
    if (!isSupabaseConnected()) return;
    for (const item of (db.media || [])) {
      if (!item.storageKey) { item.dataUrl = null; continue; }
      try {
        const { data, error } = await supabaseClient.storage.from(SUPABASE_MEDIA_BUCKET).createSignedUrl(item.storageKey, 3600);
        item.dataUrl = error ? null : data?.signedUrl || null;
      } catch { item.dataUrl = null; }
    }
  }

  async function loadRemoteWorkspace(authUser) {
    if (!isSupabaseConnected() || !authUser?.id) return;
    remoteBooting = true;
    try {
      const { data: profile, error: profileError } = await supabaseClient
        .from('users')
        .select('id,name,email,phone,role,institution_id,is_admin,permissions,created_at')
        .eq('id', authUser.id)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile) throw new Error('O perfil do usuário não foi criado. Confira se o SQL de configuração do Supabase foi executado.');

      const collections = ['institutions','users','elders','links','records','media','messages','notifications','videoAppointments'];
      const results = await Promise.all(collections.map(async collection => [collection, await remoteQuery(collection, collection === 'users' ? 'id,name,email,phone,role,institution_id,is_admin,permissions,created_at' : '*')]));
      const remoteDb = Object.fromEntries(results);
      db = {
        institutions: remoteDb.institutions,
        users: remoteDb.users,
        elders: remoteDb.elders,
        links: remoteDb.links,
        records: remoteDb.records,
        media: remoteDb.media,
        messages: remoteDb.messages,
        notifications: remoteDb.notifications,
        requests: [],
        videoAppointments: remoteDb.videoAppointments,
        settings: { storageEnabled: false },
        nextId: db.nextId || 10
      };

      // Familiares sem vínculo só recebem um diretório mínimo (nome e instituição),
      // nunca o perfil detalhado de residentes aos quais ainda não têm acesso.
      const { data: directory, error: directoryError } = await supabaseClient.rpc('list_resident_directory');
      if (!directoryError && Array.isArray(directory)) {
        for (const row of directory) {
          if (!db.institutions.some(inst => inst.id === row.institution_id)) {
            db.institutions.push({id:row.institution_id,name:row.institution_name,city:row.institution_city || null,status:'active'});
          }
          if (!db.elders.some(elder => elder.id === row.id)) {
            db.elders.push({id:row.id,name:row.name,institutionId:row.institution_id,birthDate:null,observations:'',emergencyContactName:'',emergencyContactPhone:'',avatar:(row.name || '?').charAt(0).toUpperCase(),familyIds:[],createdAt:null,directoryOnly:true});
          }
        }
      } else if (directoryError) {
        console.warn('[Laços/Supabase] Diretório de residentes indisponível:', directoryError.message);
      }
      rebuildElderFamilyIds();
      await resolveMediaUrls();
      remoteCurrentUserId = authUser.id;
      login(fromDbRow('users', profile));
    } finally {
      remoteBooting = false;
    }
  }

  function remoteWriteError(action, error) {
    console.error(`[Laços/Supabase] ${action}:`, error);
    toast(`O Supabase recusou a operação (${error?.message || 'erro desconhecido'}). Confira as políticas RLS e o SQL de configuração.`, 'error');
  }

  function persistRemoteCreate(collection, item) {
    if (!isSupabaseConnected() || remoteBooting) return;
    if (collection === 'users' || collection === 'institutions') return;
    const row = toDbRow(collection, item);
    supabaseClient.from(TABLES[collection]).insert(row).then(({error}) => {
      if (error) { remoteWriteError(`Inserção em ${TABLES[collection]}`, error); void refreshRemoteCollection(collection); }
      else if (collection === 'links' || collection === 'records' || collection === 'media' || collection === 'messages') {
        if (collection === 'links') { void refreshRemoteCollection('links'); void refreshRemoteCollection('notifications'); }
        else void refreshRemoteCollection('notifications');
      }
    });
  }

  function persistRemoteUpdate(collection, key, changes) {
    if (!isSupabaseConnected() || remoteBooting) return;
    if (collection === 'users') changes = Object.fromEntries(Object.entries(changes).filter(([key]) => ['name','phone'].includes(key)));
    const row = toDbRow(collection, changes);
    if (!Object.keys(row).length) return;
    supabaseClient.from(TABLES[collection]).update(row).eq('id', key).then(({error}) => {
      if (error) { remoteWriteError(`Atualização em ${TABLES[collection]}`, error); void refreshRemoteCollection(collection); }
      else if (collection === 'links') { void refreshRemoteCollection('links'); void refreshRemoteCollection('notifications'); }
    });
  }

  function persistRemoteDelete(collection, key) {
    if (!isSupabaseConnected() || remoteBooting) return;
    if (collection === 'users' || collection === 'institutions') return;
    supabaseClient.from(TABLES[collection]).delete().eq('id', key).then(({error}) => {
      if (error) { remoteWriteError(`Exclusão em ${TABLES[collection]}`, error); void refreshRemoteCollection(collection); }
    });
  }
  const state = { user: null, page: 'dashboard', modal: null, activeElderId: 'elder-1', activeConversation: 'conv-1', video: { status: 'ready', mic: true, camera: true }, storageEnabled: false };

  const seed = {
    users: [
      { id:'user-family', name:'Mariana Oliveira', email:'familia@lacos.demo', password:'Familia123', role:'family', createdAt:'2026-09-15T12:00:00.000Z' },
      { id:'user-staff', name:'Ana Paula Santos', email:'equipe@lacos.demo', password:'Equipe123', role:'staff', institutionId:'inst-1', permissions:{viewElders:true,recordRoutine:true,recordIncident:true,uploadMedia:true,replyMessages:true,manageLinks:false,manageStaff:false}, createdAt:'2026-09-15T12:00:00.000Z' },
      { id:'user-admin', name:'Roberto Lima', email:'admin@lacos.demo', password:'Admin123', role:'staff', isAdmin:true, institutionId:'inst-1', permissions:{viewElders:true,recordRoutine:true,recordIncident:true,uploadMedia:true,replyMessages:true,manageLinks:true,manageStaff:true}, createdAt:'2026-09-15T12:00:00.000Z' }
    ],
    institutions: [
      { id:'inst-1', name:'Casa Horizonte', city:'Itapetininga/SP', email:'contato@casahorizonte.demo', status:'active' }
    ],
    elders: [
      { id:'elder-1', name:'Dona Lúcia Oliveira', birthDate:'1944-03-12', institutionId:'inst-1', observations:'Gosta de jardinagem, música brasileira e rodas de conversa.', emergencyContactName:'Mariana Oliveira', emergencyContactPhone:'(15) 90000-0000', avatar:'L', familyIds:['user-family'], createdAt:'2026-09-15T12:00:00.000Z' },
      { id:'elder-2', name:'Seu Antônio Oliveira', birthDate:'1940-11-22', institutionId:'inst-1', observations:'Gosta de xadrez e de conversar sobre futebol.', emergencyContactName:'Mariana Oliveira', emergencyContactPhone:'(15) 90000-0000', avatar:'A', familyIds:[], createdAt:'2026-09-15T12:00:00.000Z' },
    ],
    links: [
      { id:'link-1', userId:'user-family', elderId:'elder-1', institutionId:'inst-1', status:'approved', createdAt:'2026-09-15T12:00:00.000Z', reviewedBy:'user-admin' }
    ],
    records: [
      { id:'record-1', elderId:'elder-1', category:'activity', title:'Manhã de jardinagem', description:'Lúcia participou do cuidado com as plantas do jardim e conversou com outras residentes.', dateTime:'2026-10-11T10:15:00', observations:'Demonstrou interesse pelas flores novas.', priority:false, authorId:'user-staff', authorName:'Ana Paula Santos', createdAt:'2026-10-11T10:15:00' },
      { id:'record-2', elderId:'elder-1', category:'food', title:'Almoço', description:'Almoçou junto ao grupo na área comum.', dateTime:'2026-10-11T12:20:00', observations:'Registro geral da rotina.', priority:false, authorId:'user-staff', authorName:'Ana Paula Santos', createdAt:'2026-10-11T12:20:00' },
      { id:'record-3', elderId:'elder-1', category:'mood', title:'Boa disposição', description:'Participou da roda de conversa e compartilhou histórias da juventude.', dateTime:'2026-10-10T15:30:00', observations:'Interação espontânea com o grupo.', priority:false, authorId:'user-staff', authorName:'Ana Paula Santos', createdAt:'2026-10-10T15:30:00' },
      { id:'record-4', elderId:'elder-1', category:'wellbeing', title:'Acompanhamento da rotina', description:'A equipe registrou uma alteração importante na disposição e recomenda conversar diretamente com a instituição para mais informações.', dateTime:'2026-10-09T11:10:00', observations:'Exemplo demonstrativo de registro prioritário.', priority:true, authorId:'user-staff', authorName:'Ana Paula Santos', createdAt:'2026-10-09T11:10:00' },
      { id:'record-5', elderId:'elder-2', category:'social', title:'Partida de xadrez', description:'Participou de uma partida de xadrez com outro residente.', dateTime:'2026-10-10T16:00:00', observations:'Atividade recreativa.', priority:false, authorId:'user-staff', authorName:'Ana Paula Santos', createdAt:'2026-10-10T16:00:00' }
    ],
    media: [
      { id:'media-1', elderId:'elder-1', type:'photo', title:'No jardim', caption:'Um tempinho entre as plantas nesta manhã.', dateTime:'2026-10-11T10:40:00', color:'green', authorId:'user-staff', dataUrl:null },
      { id:'media-2', elderId:'elder-1', type:'photo', title:'Roda de conversa', caption:'Uma tarde de boas histórias e companhia.', dateTime:'2026-10-10T15:45:00', color:'peach', authorId:'user-staff', dataUrl:null },
      { id:'media-3', elderId:'elder-2', type:'video', title:'Momento musical', caption:'Trecho de atividade musical compartilhada pela equipe.', dateTime:'2026-10-09T16:10:00', color:'lilac', authorId:'user-staff', dataUrl:null }
    ],
    messages: [
      { id:'msg-1', conversationId:'conv-1', elderId:'elder-1', senderId:'user-staff', senderName:'Ana Paula · Equipe', text:'Olá, Mariana! Compartilhamos alguns registros da rotina da Dona Lúcia. Se tiver alguma dúvida, estamos por aqui.', dateTime:'2026-10-11T13:00:00', assisted:false },
      { id:'msg-2', conversationId:'conv-1', elderId:'elder-1', senderId:'user-family', senderName:'Mariana Oliveira', text:'Obrigada por compartilhar! Ela gosta muito de ficar no jardim. ❤️', dateTime:'2026-10-11T13:20:00', assisted:false },
      { id:'msg-3', conversationId:'conv-1', elderId:'elder-1', senderId:'user-staff', senderName:'Ana Paula · Equipe', text:'Que bom saber! Vamos continuar registrando esses momentos.', dateTime:'2026-10-11T13:35:00', assisted:false }
    ],
    notifications: [
      { id:'notice-1', userId:'user-family', elderId:'elder-1', title:'Novo registro na rotina', text:'A equipe compartilhou um registro da manhã de jardinagem.', dateTime:'2026-10-11T10:20:00', read:false, kind:'routine' },
      { id:'notice-2', userId:'user-family', elderId:'elder-1', title:'Novo momento compartilhado', text:'Uma foto da atividade no jardim está disponível.', dateTime:'2026-10-11T10:45:00', read:false, kind:'media' },
      { id:'notice-3', userId:'user-family', elderId:'elder-1', title:'Aviso da instituição', text:'A instituição pede que as famílias combinem previamente os horários de visita deste fim de semana.', dateTime:'2026-10-10T16:00:00', read:true, kind:'notice' }
    ],
    requests: [],
    videoAppointments: [],
    settings: { storageEnabled:false },
    nextId: 10
  };
  let db = structuredCloneSafe(seed);

  function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value)); }
  function id(prefix) { db.nextId = (db.nextId || 1) + 1; return `${prefix}-${Date.now().toString(36)}-${db.nextId}`; }
  function escapeHTML(value='') { return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
  // Contato de emergência: nome e telefone são campos separados (emergencyContactName / emergencyContactPhone).
  function phoneDigits(value='') { return String(value).replace(/\D/g,'').slice(0,11); }
  function formatPhone(value='') { const d=phoneDigits(value); if (!d) return ''; if (d.length<=2) return `(${d}`; if (d.length<=6) return `(${d.slice(0,2)}) ${d.slice(2)}`; if (d.length<=10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`; return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`; }
  function validPhone(value='') { const d=phoneDigits(value); return /^[1-9][1-9](9\d{8}|[2-5]\d{7})$/.test(d); }
  function emergencyContactText(elder) { const name=(elder?.emergencyContactName||'').trim(), phone=(elder?.emergencyContactPhone||'').trim(); return name&&phone?`${name} · ${phone}`:(name||phone||''); }
  function splitLegacyContact(text='') { const parts=String(text).split('·'); if (parts.length>=2) return {name:parts[0].trim(),phone:parts.slice(1).join('·').trim()}; const m=String(text).match(/\(?\d[\d\s().-]{7,}$/); return m?{name:String(text).slice(0,m.index).replace(/[\s,;-]+$/,'').trim(),phone:m[0].trim()}:{name:String(text).trim(),phone:''}; }
  function formatDate(value, withTime=false) { if (!value) return '—'; const date = new Date(value); if (Number.isNaN(date.getTime())) return '—'; return new Intl.DateTimeFormat('pt-BR', withTime ? {dateStyle:'short',timeStyle:'short'} : {dateStyle:'short'}).format(date); }
  function toLocalDateTimeInput(date=new Date()) { const pad=value=>String(value).padStart(2,'0'); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
  function formatLongDate(value=new Date()) { return new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(value)); }
  function ageFrom(date) { if (!date) return 'Idade não informada'; const birth = new Date(`${date}T12:00:00`); const now = new Date(); let age = now.getFullYear()-birth.getFullYear(); if (now.getMonth()<birth.getMonth() || (now.getMonth()===birth.getMonth() && now.getDate()<birth.getDate())) age--; return `${age} anos`; }
  function categoryName(category) { return ({food:'Alimentação',wellbeing:'Bem-estar geral',activity:'Atividades',sleep:'Sono e descanso',mood:'Humor',visit:'Visitas',social:'Interação social',observation:'Observações gerais',incident:'Ocorrência importante'})[category] || 'Registro'; }
  function categoryIcon(category) { return ({food:'♧',wellbeing:'♡',activity:'✳',sleep:'☾',mood:'☀',visit:'⌂',social:'♧',observation:'▤',incident:'!'}[category] || '◷'); }
  function roleName(role) { return ({family:'Familiar',staff:'Equipe da instituição'})[role] || 'Usuário'; }
  function isAdmin(user=currentUser()) { return Boolean(user && user.role==='staff' && user.isAdmin); }
  function userRoleLabel(user) { return isAdmin(user) ? 'Administrador da equipe' : roleName(user?.role); }
  function currentUser() { return state.user ? db.users.find(user=>user.id===state.user.id) || state.user : null; }
  function currentInstitution() {
    const user = currentUser();
    const preferredId = user?.institutionId || db.elders.find(elder => elder.id === state.activeElderId)?.institutionId;
    return db.institutions.find(item => item.id === preferredId) || db.institutions[0] || null;
  }
  function can(permission) { const user=currentUser(); if (!user) return false; if (isAdmin(user)) return true; if (user.role==='staff') return Boolean(user.permissions?.[permission]); return false; }
  function canSeeElder(elder) { const user=currentUser(); if (!user || !elder || elder.directoryOnly) return false; if (user.role==='staff') return user.institutionId===elder.institutionId && can('viewElders'); return elder.familyIds.includes(user.id) && db.links.some(link=>link.userId===user.id && link.elderId===elder.id && link.status==='approved'); }
  function linkedElders(user=currentUser()) { if (!user) return []; if (user.role==='family') return db.elders.filter(elder=>elder.familyIds.includes(user.id) && canSeeElder(elder)); if (user.role==='staff') return db.elders.filter(elder=>elder.institutionId===user.institutionId && canSeeElder(elder)); return []; }
  function pendingLinks() { const user=currentUser(); if (!user || !(user.role==='staff' && can('manageLinks'))) return []; return db.links.filter(link=>link.status==='pending' && link.institutionId===user.institutionId); }
  function notify(userId,title,text,kind='notice',elderId=null) {
    // No modo Supabase, triggers SQL criam notificações de forma confiável.
    if (isSupabaseConnected()) return;
    db.notifications.unshift({id:id('notice'),userId,title,text,kind,elderId,dateTime:new Date().toISOString(),read:false});
  }
  function persistIfEnabled() { if (isSupabaseConnected() || !state.storageEnabled) return; try { localStorage.setItem(STORAGE_KEY,JSON.stringify(db)); } catch (error) { toast('Não foi possível salvar neste navegador.','error'); state.storageEnabled=false; } }
  function normalizeSingleInstitutionData() {
    db.institutions=[structuredCloneSafe(seed.institutions[0])];
    db.elders=(db.elders||[]).filter(elder=>elder.institutionId==='inst-1').map(elder=>{ const next={...elder,institutionId:'inst-1',familyIds:Array.isArray(elder.familyIds)?elder.familyIds:[]}; if (next.emergencyContact!==undefined) { if (next.emergencyContactName===undefined&&next.emergencyContactPhone===undefined) { const legacy=splitLegacyContact(next.emergencyContact); next.emergencyContactName=legacy.name; next.emergencyContactPhone=legacy.phone; } delete next.emergencyContact; } return next; });
    const elderIds=new Set(db.elders.map(elder=>elder.id));
    db.users=(db.users||[]).filter(user=>['family','staff'].includes(user.role)).map(user=>user.role==='staff'?({...user,institutionId:'inst-1'}):user);
    const validUserIds=new Set(db.users.map(user=>user.id));
    db.elders.forEach(elder=>{elder.familyIds=elder.familyIds.filter(userId=>validUserIds.has(userId));});
    db.links=(db.links||[]).filter(link=>elderIds.has(link.elderId)&&validUserIds.has(link.userId)).map(link=>({...link,institutionId:'inst-1'}));
    for (const collection of ['records','media','messages','videoAppointments']) db[collection]=(db[collection]||[]).filter(item=>!item.elderId||elderIds.has(item.elderId));
    db.notifications=(db.notifications||[]).filter(item=>validUserIds.has(item.userId)&&(!item.elderId||elderIds.has(item.elderId)));
    db.settings={...(db.settings||{}),storageEnabled:Boolean(db.settings?.storageEnabled)};
  }
  function loadStorage() { try { const raw=localStorage.getItem(STORAGE_KEY); if (raw) { const saved=JSON.parse(raw); db={...structuredCloneSafe(seed),...saved}; state.storageEnabled=Boolean(db.settings?.storageEnabled); } } catch (error) { console.warn('Não foi possível carregar o estado local do protótipo.',error); } normalizeSingleInstitutionData(); }
  function setStorageEnabled(enabled) {
    if (isSupabaseConnected()) { state.storageEnabled=false; db.settings.storageEnabled=false; toast('O Supabase é o armazenamento ativo; o salvamento local fica desativado.'); renderPage(); return; }
    state.storageEnabled=Boolean(enabled); db.settings.storageEnabled=state.storageEnabled;
    if (state.storageEnabled) { try { localStorage.setItem(STORAGE_KEY,JSON.stringify(db)); toast('Salvamento local ativado neste navegador.'); } catch(error) { state.storageEnabled=false; db.settings.storageEnabled=false; toast('O navegador não permitiu o salvamento local.','error'); } }
    else { try { localStorage.removeItem(STORAGE_KEY); } catch {} toast('Salvamento local desativado. Os dados desta sessão permanecem até sair/recarregar.'); }
    renderPage();
  }
  const DataService = {
    list(collection, predicate=()=>true) { return (db[collection]||[]).filter(predicate); },
    get(collection, key) { return (db[collection]||[]).find(item=>item.id===key) || null; },
    create(collection, item) {
      if (!Array.isArray(db[collection])) throw new Error('Coleção inválida.');
      const next={id:item.id||id(collection.endsWith('s')?collection.slice(0,-1):collection),...item};
      db[collection].unshift(next); persistIfEnabled(); persistRemoteCreate(collection,next); return next;
    },
    update(collection, key, changes) {
      const item=this.get(collection,key); if (!item) return null;
      Object.assign(item,changes); persistIfEnabled(); persistRemoteUpdate(collection,key,changes); return item;
    },
    remove(collection,key) {
      if (!Array.isArray(db[collection])) return false;
      const length=db[collection].length; db[collection]=db[collection].filter(item=>item.id!==key);
      persistIfEnabled(); persistRemoteDelete(collection,key); return db[collection].length!==length;
    }
  };

  function toast(message,type='success',title='') { const region=$('#toast-region'); const item=document.createElement('div'); item.className=`toast ${type==='error'?'error':''}`; item.innerHTML=`<span class="toast-symbol">${type==='error'?'!':'✓'}</span><div><strong>${escapeHTML(title||(type==='error'?'Confira esta informação':'Tudo certo'))}</strong><p>${escapeHTML(message)}</p></div>`; region.append(item); window.setTimeout(()=>item.remove(),4300); }
  function showPublic() { $('#public-view').classList.remove('hidden'); $('#auth-view').classList.add('hidden'); $('#workspace-view').classList.add('hidden'); $('#modal').close?.(); window.scrollTo({top:0,behavior:'smooth'}); }
  function showAuth(mode='login') { $('#public-view').classList.add('hidden'); $('#auth-view').classList.remove('hidden'); $('#workspace-view').classList.add('hidden'); setAuthMode(mode); window.scrollTo({top:0,behavior:'smooth'}); }
  function setAuthMode(mode) { const isLogin=mode==='login', isSignup=mode==='signup'; $('#login-form').classList.toggle('hidden',!isLogin); $('#signup-form').classList.toggle('hidden',!isSignup); $('#auth-eyebrow').textContent=isLogin?'BEM-VINDO(A)':'COMECE POR AQUI'; $('#auth-title').textContent=isLogin?'Entre na sua conta':'Crie sua conta'; $('#auth-description').textContent=isLogin?'Que bom ter você por aqui.':'Cadastre-se para solicitar acesso aos registros do seu familiar.'; $('#auth-demo-hint').classList.remove('hidden'); }
  function clearValidation(form) { $$('[aria-invalid="true"]',form).forEach(field=>field.removeAttribute('aria-invalid')); $$('.auth-error,.auth-success',form).forEach(el=>el.remove()); }
  function formMessage(form,message,type='error') { const el=document.createElement('p'); el.className=type==='error'?'auth-error':'auth-success'; el.setAttribute('role','status'); el.textContent=message; form.prepend(el); }
  function markInvalid(field) { field.setAttribute('aria-invalid','true'); }
  function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()); }
  function validPassword(value) { return value.length>=6 && /\d/.test(value); }
  async function handleLogin(event) {
    event.preventDefault(); const form=event.target; clearValidation(form);
    const email=$('#login-email').value.trim().toLowerCase(), password=$('#login-password').value;
    let valid=true; if (!validEmail(email)) { markInvalid($('#login-email')); valid=false; }
    if (!password) { markInvalid($('#login-password')); valid=false; }
    if (!valid) { formMessage(form,'Informe um e-mail válido e sua senha.'); return; }
    if (isSupabaseConfigured() && !isSupabaseConnected()) { formMessage(form,'A conexão com o Supabase não inicializou. Confira a URL, a chave e o console do navegador.'); return; }
    if (isSupabaseConnected()) {
      const { data, error } = await supabaseClient.auth.signInWithPassword({email,password});
      if (error) { markInvalid($('#login-password')); formMessage(form,'Não foi possível entrar. Confira o e-mail e a senha cadastrados no Supabase Auth.'); return; }
      try { await loadRemoteWorkspace(data.user); }
      catch (loadError) { console.error(loadError); formMessage(form,'Login concluído, mas não foi possível carregar o perfil. Confira o SQL/RLS do Supabase.'); }
      return;
    }
    const user=db.users.find(item=>item.email.toLowerCase()===email);
    if (!user || user.password!==password) { markInvalid($('#login-password')); formMessage(form,'E-mail ou senha incorretos. Confira os dados e tente novamente.'); return; }
    login(user);
  }
  async function handleSignup(event) {
    event.preventDefault(); const form=event.target; clearValidation(form);
    const name=$('#signup-name').value.trim(), email=$('#signup-email').value.trim().toLowerCase(), password=$('#signup-password').value, confirm=$('#signup-confirm').value;
    let valid=true;
    const fields=[['signup-name',Boolean(name),'Informe seu nome completo.'],['signup-email',validEmail(email),'Informe um e-mail válido.'],['signup-password',validPassword(password),'A senha precisa ter pelo menos 6 caracteres e um número.'],['signup-confirm',password===confirm && Boolean(confirm),'As senhas precisam ser iguais.']];
    for (const [fieldId,ok,message] of fields) { if (!ok) { markInvalid($('#'+fieldId)); valid=false; } }
    if (!valid) { formMessage(form,'Revise os campos destacados.'); return; }
    if (isSupabaseConfigured() && !isSupabaseConnected()) { formMessage(form,'A conexão com o Supabase não inicializou. Confira a URL, a chave e o console do navegador.'); return; }
    if (isSupabaseConnected()) {
      const { data, error } = await supabaseClient.auth.signUp({email,password,options:{data:{name}}});
      if (error) { formMessage(form,error.message || 'Não foi possível criar a conta.'); return; }
      if (data.session && data.user) {
        try { await loadRemoteWorkspace(data.user); }
        catch (loadError) { console.error(loadError); formMessage(form,'Conta criada, mas não foi possível carregar o perfil. Confira o SQL/RLS.'); }
      } else {
        formMessage(form,'Conta criada. Confira seu e-mail para confirmar o cadastro e depois entre no sistema.','success');
      }
      return;
    }
    if (db.users.some(user=>user.email.toLowerCase()===email)) { markInvalid($('#signup-email')); formMessage(form,'Já existe uma conta com este e-mail. Entre ou use outro endereço.'); return; }
    const user=DataService.create('users',{name,email,password,role:'family',createdAt:new Date().toISOString()}); toast('Conta criada. Agora solicite o vínculo com o idoso na área “Vínculos familiares”.'); login(user);
  }

  function login(user) { state.user=user; state.page='dashboard'; state.activeElderId=linkedElders(user)[0]?.id || db.elders.find(elder=>elder.institutionId===user.institutionId && !elder.directoryOnly)?.id || null; $('#public-view').classList.add('hidden'); $('#auth-view').classList.add('hidden'); $('#workspace-view').classList.remove('hidden'); renderWorkspace(); }
  async function logout() {
    closeAccountMenu();
    if (isSupabaseConnected()) { const {error}=await supabaseClient.auth.signOut(); if(error) console.error('[Laços/Supabase] signOut:',error); }
    state.user=null; remoteCurrentUserId=null; state.page='dashboard'; state.video={status:'ready',mic:true,camera:true}; showPublic();
  }
  function navItemsForRole(role) { if (role==='family') return [{id:'dashboard',label:'Visão geral',icon:'⌂'},{id:'routine',label:'Rotina e histórico',icon:'◷'},{id:'media',label:'Fotos e vídeos',icon:'▧'},{id:'messages',label:'Mensagens',icon:'▤'},{id:'video',label:'Chamada de vídeo',icon:'▻'},{id:'notifications',label:'Notificações',icon:'♧',count:true},{id:'links',label:'Vínculos familiares',icon:'♡'},{id:'settings',label:'Preferências',icon:'⚙'}]; const admin=isAdmin(); return [{id:'dashboard',label:'Visão geral',icon:'⌂'},{id:'routine',label:'Rotina e registros',icon:'◷',show:can('recordRoutine')||can('recordIncident')},{id:'media',label:'Fotos e vídeos',icon:'▧',show:can('uploadMedia')},{id:'messages',label:'Mensagens',icon:'▤',show:can('replyMessages')},{id:'notifications',label:'Notificações',icon:'♧',count:true},{id:'links',label:admin?'Vínculos familiares':'Solicitações de vínculo',icon:'♡',count:true,show:can('manageLinks')},{id:'elders',label:'Gestão de residentes',icon:'❀',show:admin},{id:'staff',label:'Gestão da equipe',icon:'♙',show:admin},{id:'settings',label:'Preferências',icon:'⚙'}].filter(item=>item.show!==false); }
  function pageLabel(page) { return ({dashboard:'Visão geral',routine:'Rotina e histórico',media:'Fotos e vídeos',messages:'Mensagens',video:'Chamada de vídeo',notifications:'Notificações',links:'Vínculos familiares',staff:'Equipe e permissões',elders:'Residentes',settings:'Preferências',profile:'Meu perfil'})[page] || 'Visão geral'; }
  function renderWorkspace() { const user=currentUser(); if (!user) return; $('#sidebar-role').textContent=userRoleLabel(user); $('#sidebar-org').textContent=currentInstitution()?.name||'Área da família'; $('#profile-name').textContent=user.name; $('#profile-role').textContent=userRoleLabel(user); $('#profile-avatar').textContent=(user.name||'?').trim().charAt(0).toUpperCase(); $('#topbar-avatar').textContent=(user.name||'?').trim().charAt(0).toUpperCase(); renderAccountMenu(user); $('#topbar-date').textContent=formatLongDate(); const nav=navItemsForRole(user.role); $('#sidebar-nav').innerHTML=nav.map(item=>`<button class="nav-item ${state.page===item.id?'active':''}" data-action="navigate" data-page="${item.id}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span>${item.count && item.id==='links' && pendingLinks().length?`<span class="nav-count">${pendingLinks().length}</span>`:''}${item.id==='notifications' && unreadNotifications().length?`<span class="nav-count">${unreadNotifications().length}</span>`:''}</button>`).join(''); $('#notification-dot').style.display=unreadNotifications().length?'block':'none'; $('#page-breadcrumb').textContent=pageLabel(state.page); renderPage(); }
  // ---- Menu da conta (ícone com a inicial, no canto superior direito) ----
  function renderAccountMenu(user) {
    const menu=$('#account-menu'); if (!menu) return;
    menu.innerHTML=`<div class="account-dropdown-head"><strong>${escapeHTML(user.name||'')}</strong><small>${escapeHTML(user.email||'')}</small><span class="status-pill neutral">${escapeHTML(userRoleLabel(user))}</span></div><button class="account-item" role="menuitem" data-action="account-profile"><span aria-hidden="true">♙</span>Meu perfil</button><button class="account-item" role="menuitem" data-action="account-password"><span aria-hidden="true">⚙</span>Alterar senha</button><button class="account-item danger" role="menuitem" data-action="logout"><span aria-hidden="true">↪</span>Sair da conta</button>`;
  }
  function toggleAccountMenu(force) {
    const menu=$('#account-menu'), trigger=$('#topbar-avatar'); if (!menu||!trigger) return;
    const open=force===undefined?menu.classList.contains('hidden'):force;
    menu.classList.toggle('hidden',!open); trigger.setAttribute('aria-expanded',String(open));
    if (open) menu.querySelector('.account-item')?.focus();
  }
  function closeAccountMenu() { if (!$('#account-menu')?.classList.contains('hidden')) toggleAccountMenu(false); }
  function navigate(page) { state.page=page; if (window.innerWidth<=760) $('#sidebar').classList.remove('open'); renderWorkspace(); window.scrollTo({top:0,behavior:'smooth'}); }
  function pageHeading(title,subtitle,actions='') { return `<div class="page-heading"><div><span class="page-kicker">${escapeHTML(currentInstitution()?.name || 'ESPAÇO LAÇOS')}</span><h1>${title}</h1><p>${subtitle}</p></div>${actions?`<div class="page-heading-actions">${actions}</div>`:''}</div>`; }
  function renderPage() { const content=$('#page-content'); const pages={dashboard:renderDashboard,routine:renderRoutine,media:renderMedia,messages:renderMessages,video:renderVideo,notifications:renderNotifications,links:renderLinks,staff:renderStaff,elders:renderElders,settings:renderSettings,profile:renderProfile}; content.innerHTML=(pages[state.page]||renderDashboard)(); if (state.page==='messages') scrollChatToBottom(); }
  function renderDashboard() { const user=currentUser(); if (user.role==='staff') return isAdmin(user) ? renderAdminStaffDashboard() : renderStaffDashboard(); const elders=linkedElders(user); const myLinks=db.links.filter(link=>link.userId===user.id && link.status==='pending'); const allRecords=db.records.filter(record=>elders.some(elder=>elder.id===record.elderId)).sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)); const media=db.media.filter(item=>elders.some(elder=>elder.id===item.elderId)); const notices=unreadNotifications(); return `<section class="dashboard-welcome"><div><span class="eyebrow">${formatLongDate()}</span><h1>Olá, ${escapeHTML(user.name.split(' ')[0])} ✳</h1><p>Um lugar para acompanhar a rotina e manter a família por perto.</p></div><div class="welcome-decoration" aria-hidden="true">✳</div></section><div class="stat-grid"><article class="stat-card"><span class="stat-icon">♡</span><div><small>Familiares acompanhados</small><strong>${elders.length}</strong><span class="stat-note">Vínculos aprovados</span></div></article><article class="stat-card"><span class="stat-icon peach">◷</span><div><small>Registros recentes</small><strong>${allRecords.length}</strong><span class="stat-note">Na rotina compartilhada</span></div></article><article class="stat-card"><span class="stat-icon lilac">▧</span><div><small>Momentos compartilhados</small><strong>${media.length}</strong><span class="stat-note">Fotos e vídeos</span></div></article><article class="stat-card"><span class="stat-icon yellow">♧</span><div><small>Não lidas</small><strong>${notices.length}</strong><span class="stat-note">Notificações</span></div></article></div>${myLinks.length?`<div class="inline-notice">Você tem ${myLinks.length} solicitação(ões) de vínculo aguardando aprovação. A instituição libera os dados somente depois da aprovação.</div>`:''}<div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>Minha família</h2><p>Perfis com vínculo autorizado</p></div><button class="subtle-link" data-action="navigate" data-page="links">Gerenciar vínculos →</button></div>${elders.length?`<div class="elder-grid">${elders.map(elderCard).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">♡</div><strong>Vamos conectar sua família?</strong><p>Solicite o vínculo com a instituição para acompanhar os registros do seu familiar.</p><button class="btn btn-primary" data-action="navigate" data-page="links">Solicitar vínculo</button></div>`}</section><section class="panel"><div class="panel-heading"><div><h2>Atividade recente</h2><p>Últimas atualizações compartilhadas</p></div><button class="subtle-link" data-action="navigate" data-page="routine">Ver histórico →</button></div>${allRecords.length?`<div class="timeline">${allRecords.slice(0,4).map(recordTimelineItem).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">◷</div><strong>Nenhum registro por enquanto</strong><p>Quando a instituição compartilhar atualizações, elas aparecerão aqui.</p></div>`}</section></div><div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>Momentos recentes</h2><p>Compartilhados pela equipe da instituição</p></div><button class="subtle-link" data-action="navigate" data-page="media">Ver galeria →</button></div>${media.length?`<div class="media-grid">${media.slice(0,3).map(mediaCard).join('')}</div>`:`<div class="empty-state"><strong>Os momentos aparecerão aqui</strong><p>A equipe pode compartilhar fotos e vídeos quando houver novidades.</p></div>`}</section><section class="panel"><div class="panel-heading"><div><h2>Mensagens</h2><p>Converse com a equipe</p></div><button class="subtle-link" data-action="navigate" data-page="messages">Abrir caixa →</button></div>${renderMessagePreview()}</section></div>`; }
  function renderAdminStaffDashboard() { const user=currentUser(), elders=db.elders.filter(elder=>elder.institutionId==='inst-1'), requests=pendingLinks(), staff=db.users.filter(item=>item.role==='staff'&&!item.isAdmin), families=db.users.filter(item=>item.role==='family'), records=db.records.filter(record=>elders.some(elder=>elder.id===record.elderId)); const institution=currentInstitution(); return `${pageHeading(`Painel administrativo · ${escapeHTML(user.name.split(' ')[0])}`,'Gerencie a instituição, os residentes, a equipe e as solicitações de acesso.',`<button class="btn btn-outline" data-action="navigate" data-page="staff">Gerenciar equipe</button><button class="btn btn-primary" data-action="open-modal" data-modal="new-elder">＋ Cadastrar residente</button>`)}<div class="dashboard-welcome"><div><span class="eyebrow">ADMINISTRAÇÃO DA INSTITUIÇÃO</span><h1>${escapeHTML(institution?.name||'Casa Horizonte')}</h1><p>Visão geral de cadastros, acessos e operação institucional.</p></div><div class="welcome-decoration" aria-hidden="true">⌂</div></div><div class="stat-grid"><article class="stat-card"><span class="stat-icon">❀</span><div><small>Residentes cadastrados</small><strong>${elders.length}</strong><span class="stat-note">Perfis da instituição</span></div></article><article class="stat-card"><span class="stat-icon peach">♙</span><div><small>Funcionários</small><strong>${staff.length}</strong><span class="stat-note">Contas não administrativas</span></div></article><article class="stat-card"><span class="stat-icon lilac">♡</span><div><small>Contas familiares</small><strong>${families.length}</strong><span class="stat-note">Cadastros no sistema</span></div></article><article class="stat-card"><span class="stat-icon yellow">!</span><div><small>Vínculos pendentes</small><strong>${requests.length}</strong><span class="stat-note">Aguardando aprovação</span></div></article></div><div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>Gestão administrativa</h2><p>Acesso rápido às tarefas de responsabilidade do administrador.</p></div></div><div class="settings-list"><div class="setting-row"><div><strong>Residentes</strong><p>Cadastrar, editar e remover perfis de idosos.</p></div><button class="btn btn-outline" data-action="navigate" data-page="elders">Gerenciar</button></div><div class="setting-row"><div><strong>Equipe e permissões</strong><p>Criar contas de funcionários e definir os acessos.</p></div><button class="btn btn-outline" data-action="navigate" data-page="staff">Gerenciar</button></div><div class="setting-row"><div><strong>Vínculos familiares</strong><p>Aprovar ou recusar solicitações de acesso aos residentes.</p></div><button class="btn btn-outline" data-action="navigate" data-page="links">Analisar (${requests.length})</button></div><div class="setting-row"><div><strong>Preferências e dados</strong><p>Gerenciar os dados de demonstração e a persistência local.</p></div><button class="btn btn-outline" data-action="navigate" data-page="settings">Abrir</button></div></div></section><section class="panel"><div class="panel-heading"><div><h2>Solicitações recentes</h2><p>O acesso só é liberado após aprovação.</p></div><button class="subtle-link" data-action="navigate" data-page="links">Ver todas →</button></div>${requests.length?requests.slice(0,5).map(linkRow).join(''):'<div class="empty-state"><strong>Nenhuma solicitação pendente</strong><p>As novas solicitações de familiares aparecerão aqui.</p></div>'}</section></div><section class="panel"><div class="panel-heading"><div><h2>Resumo operacional</h2><p>Indicadores gerais da instituição fixa.</p></div></div><div class="content-grid"><div class="detail-tile"><small>Registros de rotina</small><strong>${records.length}</strong></div><div class="detail-tile"><small>Notificações não lidas da equipe</small><strong>${db.notifications.filter(item=>db.users.some(staffUser=>staffUser.id===item.userId&&staffUser.role==='staff')&&!item.read).length}</strong></div></div><p style="font-size:.74rem;margin-top:12px">O painel administrativo prioriza a gestão. Fotos, vídeos, mensagens e registros continuam disponíveis nos respectivos menus quando necessários.</p></section>`; }
  function renderStaffDashboard() { const elders=linkedElders(); const records=db.records.filter(record=>elders.some(elder=>elder.id===record.elderId)); const pending=can('manageLinks')?pendingLinks():[]; return `${pageHeading(`Olá, ${escapeHTML(currentUser().name.split(' ')[0])} ✳`,'Registre a rotina com clareza e mantenha a família informada.',can('recordRoutine')?`<button class="btn btn-primary" data-action="navigate" data-page="routine">＋ Novo registro</button>`:'')}<div class="stat-grid"><article class="stat-card"><span class="stat-icon">♡</span><div><small>Residentes acessíveis</small><strong>${elders.length}</strong><span class="stat-note">Conforme suas permissões</span></div></article><article class="stat-card"><span class="stat-icon peach">◷</span><div><small>Registros disponíveis</small><strong>${records.length}</strong><span class="stat-note">Histórico da instituição</span></div></article><article class="stat-card"><span class="stat-icon lilac">▧</span><div><small>Mídias publicadas</small><strong>${db.media.filter(item=>elders.some(elder=>elder.id===item.elderId)).length}</strong><span class="stat-note">Fotos e vídeos</span></div></article><article class="stat-card"><span class="stat-icon yellow">♡</span><div><small>Vínculos pendentes</small><strong>${pending.length||'—'}</strong><span class="stat-note">${can('manageLinks')?'Precisam de revisão':'Acesso restrito'}</span></div></article></div><div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>Residentes</h2><p>Perfis disponíveis conforme suas permissões.</p></div></div><div class="elder-grid">${elders.map(elderCard).join('')}</div></section><section class="panel"><div class="panel-heading"><div><h2>Registros recentes</h2><p>Últimas atualizações da instituição</p></div><button class="subtle-link" data-action="navigate" data-page="routine">Ver todos →</button></div><div class="timeline">${records.sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)).slice(0,4).map(recordTimelineItem).join('')}</div></section></div>`; }
  function elderCard(elder) { const inst=db.institutions.find(item=>item.id===elder.institutionId); const status=linkStatusFor(elder.id); const records=db.records.filter(record=>record.elderId===elder.id); return `<article class="elder-card"><div class="elder-card-top"><div class="elder-photo">${escapeHTML(elder.avatar||elder.name.charAt(0))}</div><div style="min-width:0;flex:1"><h3>${escapeHTML(elder.name)}</h3><p class="elder-meta">${ageFrom(elder.birthDate)} · ${escapeHTML(inst?.name||'Instituição não informada')}</p></div></div><div class="status-row"><span class="status-pill ${status==='pending'?'pending':status==='rejected'?'rejected':''}">${status==='approved'?'Vínculo ativo':status==='pending'?'Vínculo pendente':status==='rejected'?'Vínculo recusado':'Perfil da instituição'}</span><small>${records.length} registros</small></div><div class="elder-card-actions"><button class="btn btn-outline" data-action="view-elder" data-id="${elder.id}">Ver perfil</button>${currentUser().role==='family'?`<button class="btn btn-primary" data-action="view-elder" data-id="${elder.id}">Acompanhar →</button>`:`<button class="btn btn-primary" data-action="navigate-elder" data-id="${elder.id}" data-page="routine">Registrar →</button>`}</div></article>`; }
  function linkStatusFor(elderId) { const user=currentUser(); if (user.role!=='family') return 'approved'; return db.links.find(link=>link.userId===user.id&&link.elderId===elderId)?.status||'none'; }
  function recordTimelineItem(record) { const elder=DataService.get('elders',record.elderId); return `<article class="timeline-item"><span class="timeline-icon ${record.category==='activity'?'':record.category==='food'?'peach':'lilac'}">${categoryIcon(record.category)}</span><div><h4>${escapeHTML(record.title)} ${record.priority?'<span class="priority-tag">IMPORTANTE</span>':''}</h4><p>${escapeHTML(record.description)}</p><div class="timeline-meta">${escapeHTML(elder?.name||'Residente')} · ${formatDate(record.dateTime,true)}</div></div></article>`; }
  function renderRoutine() { const user=currentUser(); const elders=linkedElders(); const actions=(can('recordRoutine')||can('recordIncident'))?`<button class="btn btn-primary" data-action="open-modal" data-modal="new-record">＋ Novo registro</button>`:''; const records=db.records.filter(record=>elders.some(elder=>elder.id===record.elderId)).sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)); return `${pageHeading('Rotina e histórico','Registros organizados por data e categoria. Este espaço não é um prontuário médico.',actions)}${user.role==='family'?'<div class="inline-notice">Os registros são compartilhados pela instituição. Para esclarecer qualquer informação, envie uma mensagem à equipe.</div>':''}<section class="panel"><div class="filter-row"><input id="routine-search" class="search-field" placeholder="Buscar nos registros..." aria-label="Buscar registros"><select id="routine-elder-filter" aria-label="Filtrar por residente"><option value="all">Todos os residentes</option>${elders.map(elder=>`<option value="${elder.id}">${escapeHTML(elder.name)}</option>`).join('')}</select><select id="routine-category-filter" aria-label="Filtrar por categoria"><option value="all">Todas as categorias</option>${Object.entries({food:'Alimentação',wellbeing:'Bem-estar geral',activity:'Atividades',sleep:'Sono e descanso',mood:'Humor',visit:'Visitas',social:'Interação social',observation:'Observações gerais',incident:'Ocorrência importante'}).map(([key,value])=>`<option value="${key}">${value}</option>`).join('')}</select><input id="routine-date-filter" type="date" aria-label="Filtrar a partir da data"></div><div id="routine-record-list" class="record-list">${records.map(recordCard).join('')||'<div class="empty-state"><strong>Nenhum registro encontrado</strong><p>Quando houver atualizações, elas serão exibidas nesta lista.</p></div>'}</div></section>`; }
  function recordCard(record) { const elder=DataService.get('elders',record.elderId); return `<article class="record-card" data-record-id="${record.id}" data-elder-id="${record.elderId}" data-category="${record.category}" data-date="${String(record.dateTime).slice(0,10)}" data-search="${escapeHTML(`${record.title} ${record.description} ${elder?.name||''} ${categoryName(record.category)}`.toLowerCase())}"><span class="timeline-icon ${record.priority?'peach':''}">${categoryIcon(record.category)}</span><div class="record-card-main"><h3>${escapeHTML(record.title)} ${record.priority?'<span class="priority-tag">IMPORTANTE</span>':''}</h3><p>${escapeHTML(record.description)}</p>${record.observations?`<p style="margin-top:5px"><strong>Observação:</strong> ${escapeHTML(record.observations)}</p>`:''}<div class="record-card-meta"><span>${escapeHTML(elder?.name||'Residente')}</span><span>${categoryName(record.category)}</span><span>${formatDate(record.dateTime,true)}</span><span>Registrado por ${escapeHTML(record.authorName||'Equipe')}</span></div></div></article>`; }
  function renderMedia() { const elders=linkedElders(); const media=db.media.filter(item=>elders.some(elder=>elder.id===item.elderId)).sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)); const action=can('uploadMedia')?`<button class="btn btn-primary" data-action="open-modal" data-modal="upload-media">＋ Compartilhar momento</button>`:''; return `${pageHeading('Fotos e vídeos','Momentos compartilhados pela equipe, com data e legenda.',action)}<div class="inline-notice">O protótipo não usa câmera ao vivo nem vigilância. Os arquivos adicionados são apenas uma demonstração no navegador.</div><section class="panel"><div class="filter-row"><select id="media-elder-filter" aria-label="Filtrar mídia por residente"><option value="all">Todos os residentes</option>${elders.map(elder=>`<option value="${elder.id}">${escapeHTML(elder.name)}</option>`).join('')} </select><select id="media-type-filter" aria-label="Filtrar mídia por tipo"><option value="all">Fotos e vídeos</option><option value="photo">Fotos</option><option value="video">Vídeos</option></select></div><div id="media-list" class="media-grid">${media.map(mediaCard).join('')||'<div class="empty-state"><strong>Nenhum momento compartilhado ainda</strong><p>Quando a equipe publicar fotos ou vídeos, eles aparecerão nesta galeria.</p></div>'}</div></section>`; }
  function mediaCard(item) { const elder=DataService.get('elders',item.elderId); const icon=item.type==='video'?'▷':'✿'; const content=item.dataUrl?`<img src="${item.dataUrl}" alt="${escapeHTML(item.title)}" style="width:100%;height:100%;object-fit:cover">`:`<span>${icon}</span>`; return `<article class="media-card" data-media-id="${item.id}" data-elder-id="${item.elderId}" data-type="${item.type}"><div class="media-art ${item.color||'green'}">${content}</div><div class="media-card-body"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.caption||'Sem legenda.')}</p><small>${escapeHTML(elder?.name||'Residente')} · ${formatDate(item.dateTime,true)}</small>${can('uploadMedia')?`<button class="text-button" style="font-size:.7rem;margin-top:8px" data-action="delete-media" data-id="${item.id}">Remover mídia</button>`:''}</div></article>`; }
  function renderMessagePreview() { const msgs=db.messages.filter(msg=>linkedElders().some(elder=>elder.id===msg.elderId)).sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)).slice(0,2); return msgs.length?msgs.map(msg=>`<div class="timeline-item"><span class="timeline-icon lilac">▤</span><div><h4>${escapeHTML(msg.senderName)}</h4><p>${escapeHTML(msg.text)}</p><div class="timeline-meta">${formatDate(msg.dateTime,true)}</div></div></div>`).join(''):'<div class="empty-state"><strong>Nenhuma mensagem</strong><p>As conversas com a equipe aparecerão aqui.</p></div>'; }
  function renderMessages() { const elders=linkedElders(); const elder=elders.find(item=>item.id===state.activeElderId)||elders[0]; if (!elder) return `${pageHeading('Mensagens','Converse com a equipe da instituição.')}<div class="panel empty-state"><strong>Nenhum familiar vinculado</strong><p>Depois que o vínculo for aprovado, você poderá trocar mensagens.</p><button class="btn btn-primary" data-action="navigate" data-page="links">Gerenciar vínculos</button></div>`; state.activeElderId=elder.id; const messages=db.messages.filter(msg=>msg.elderId===elder.id).sort((a,b)=>new Date(a.dateTime)-new Date(b.dateTime)); const mayReply=currentUser().role==='family'||can('replyMessages'); return `${pageHeading('Mensagens','Um canal de comunicação entre a família e a instituição.')}<div class="message-layout"><aside class="conversation-list">${elders.map(item=>`<button class="conversation-item ${item.id===elder.id?'active':''}" data-action="select-conversation" data-id="${item.id}"><span class="avatar ${item.id==='elder-1'?'avatar-peach':'avatar-lilac'}">${escapeHTML(item.avatar||item.name.charAt(0))}</span><span><strong>${escapeHTML(item.name)}</strong><small>Conversa com a equipe</small></span></button>`).join('')}</aside><section class="chat-panel"><header class="chat-header"><span class="avatar avatar-green">⌂</span><div><strong>${escapeHTML(elder.name)} · Equipe</strong><small>Mensagens demonstrativas</small></div></header><div id="chat-messages" class="chat-messages">${messages.map(messageBubble).join('')||'<div class="empty-state"><strong>Inicie a conversa</strong><p>Envie uma mensagem para a equipe da instituição.</p></div>'}</div>${mayReply?`<form id="message-form" class="chat-compose"><input id="message-text" placeholder="Escreva uma mensagem..." maxlength="1000" required aria-label="Escreva uma mensagem"><button class="btn btn-primary" type="submit" aria-label="Enviar mensagem">Enviar →</button></form>`:'<div class="inline-notice">Sua permissão atual não permite responder mensagens.</div>'}</section></div>`; }
  function messageBubble(msg) { const mine=msg.senderId===currentUser().id; return `<article class="chat-bubble ${mine?'mine':''}"><p>${escapeHTML(msg.text)}${msg.assisted?'<br><small>Resposta registrada pela equipe em nome do residente</small>':''}</p><small>${escapeHTML(msg.senderName)} · ${formatDate(msg.dateTime,true)}</small></article>`; }
  function scrollChatToBottom() { const chat=$('#chat-messages'); if (chat) chat.scrollTop=chat.scrollHeight; }
  function handleMessage(event) { event.preventDefault(); const text=$('#message-text').value.trim(); const elder=DataService.get('elders',state.activeElderId); if (!text || !elder) return; const user=currentUser(); if (user.role==='staff'&&!can('replyMessages')) return toast('Seu perfil não tem permissão para responder mensagens.','error'); const isFamily=user.role==='family'; DataService.create('messages',{conversationId:`conv-${elder.id}`,elderId:elder.id,senderId:user.id,senderName:isFamily?user.name:`${user.name} · Equipe`,text,dateTime:new Date().toISOString(),assisted:false}); if (isFamily) { db.users.filter(item=>item.institutionId===elder.institutionId&&item.role==='staff').forEach(item=>notify(item.id,'Nova mensagem da família',`${user.name} enviou uma mensagem sobre ${elder.name}.`,'message',elder.id)); } else { elder.familyIds.forEach(userId=>notify(userId,'Mensagem da instituição',`A equipe enviou uma mensagem sobre ${elder.name}.`,'message',elder.id)); } $('#message-text').value=''; renderPage(); toast('Mensagem registrada no protótipo.'); }
  function renderVideo() { const elders=linkedElders(); const elder=elders.find(item=>item.id===state.activeElderId)||elders[0]; if (!elder) return `${pageHeading('Chamada de vídeo','Simulação visual de uma chamada.')}<div class="panel empty-state"><strong>Vínculo necessário</strong><p>Para simular uma chamada, primeiro conecte sua conta a um familiar.</p></div>`; const status=state.video.status; const label={ready:'Pronto para iniciar',calling:'Chamando...',answered:'Chamada conectada · simulação',ended:'Chamada encerrada'}[status]; return `${pageHeading('Chamada de vídeo','Experimente os controles de uma chamada. Nenhuma conexão real será iniciada.')}<div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>Conversa com ${escapeHTML(elder.name)}</h2><p>Chamada demonstrativa · sem áudio ou vídeo real</p></div><span class="status-pill neutral">Simulação</span></div><div class="video-stage"><span class="video-status">● ${label}</span><div class="video-person">${escapeHTML(elder.avatar||elder.name.charAt(0))}</div></div><div class="video-controls"><button class="video-control ${state.video.mic?'':'off'}" data-action="toggle-mic"><span>${state.video.mic?'♬':'♩'}</span>${state.video.mic?'Microfone ligado':'Microfone desligado'}</button><button class="video-control ${state.video.camera?'':'off'}" data-action="toggle-camera"><span>${state.video.camera?'▣':'▧'}</span>${state.video.camera?'Câmera ligada':'Câmera desligada'}</button>${status==='ready'||status==='ended'?`<button class="video-control end" data-action="start-video"><span>☎</span>Iniciar chamada</button>`:`<button class="video-control end" data-action="end-video"><span>☎</span>Encerrar</button>`}</div></section><section class="panel"><div class="panel-heading"><div><h2>Como funciona</h2><p>Somente estados visuais para validar a interface.</p></div></div><div class="timeline"><article class="timeline-item"><span class="timeline-icon">✓</span><div><h4>Controles interativos</h4><p>Você pode ligar/desligar os indicadores de microfone e câmera.</p></div></article><article class="timeline-item"><span class="timeline-icon peach">!</span><div><h4>Sem conexão real</h4><p>O protótipo não acessa câmera, microfone nem utiliza WebRTC.</p></div></article><article class="timeline-item"><span class="timeline-icon lilac">♡</span><div><h4>Combine com a instituição</h4><p>Para uma chamada real, a instituição precisaria oferecer um serviço integrado e seguro.</p></div></article></div><button class="btn btn-outline btn-full" data-action="open-modal" data-modal="schedule-video">Solicitar horário de chamada</button></section></div>`; }
  function unreadNotifications() { const user=currentUser(); return user?db.notifications.filter(item=>item.userId===user.id&&!item.read):[]; }
  function renderNotifications() { const user=currentUser(); const notifications=db.notifications.filter(item=>item.userId===user.id).sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)); return `${pageHeading('Notificações','Avisos importantes, solicitações e atualizações relevantes.',notifications.some(item=>!item.read)?'<button class="btn btn-outline" data-action="mark-all-read">Marcar todas como lidas</button>':'')}<div class="inline-notice">Atualizações rotineiras ficam no histórico do familiar. Esta área reúne avisos importantes e notificações relevantes.</div>${notifications.length?notifications.map(notificationCard).join(''):'<section class="panel empty-state"><div class="empty-icon">♧</div><strong>Nenhuma notificação por enquanto</strong><p>Quando houver avisos relevantes, eles aparecerão aqui.</p></section>'}`; }
  function notificationCard(item) { return `<article class="notice-card ${item.read?'':'unread'}"><span class="notice-symbol">${item.kind==='media'?'▧':item.kind==='message'?'▤':item.kind==='routine'?'◷':'♧'}</span><div class="notice-content"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.text)}</p><small>${formatDate(item.dateTime,true)}</small></div><div class="notice-actions">${item.read?'<span class="status-pill neutral">Lida</span>':`<button class="subtle-link" data-action="mark-read" data-id="${item.id}">Marcar lida</button>`}</div></article>`; }
  function renderLinks() { const user=currentUser(); if (user.role==='family') { const links=db.links.filter(link=>link.userId===user.id); return `${pageHeading('Vínculos familiares','Solicite acesso aos registros do idoso acompanhado nesta instituição.',`<button class="btn btn-primary" data-action="open-modal" data-modal="request-link">＋ Solicitar vínculo</button>`)}<div class="inline-notice">A instituição precisa aprovar cada vínculo antes que os dados do residente sejam liberados. Não compartilhe informações privadas fora das pessoas autorizadas.</div><section class="panel"><div class="panel-heading"><div><h2>Minhas solicitações</h2><p>Estado atual de cada solicitação</p></div></div>${links.length?links.map(link=>{const elder=DataService.get('elders',link.elderId),inst=DataService.get('institutions',link.institutionId);return `<div class="notice-card"><span class="notice-symbol">♡</span><div class="notice-content"><h3>${escapeHTML(elder?.name||'Familiar')}</h3><p>${escapeHTML(inst?.name||'Instituição')} · ${escapeHTML(inst?.city||'')}</p><small>Solicitado em ${formatDate(link.createdAt)}</small></div><span class="status-pill ${link.status==='pending'?'pending':link.status==='rejected'?'rejected':''}">${link.status==='approved'?'Aprovado':link.status==='pending'?'Pendente':'Recusado'}</span></div>`}).join(''):'<div class="empty-state"><strong>Você ainda não tem vínculos</strong><p>Solicite o vínculo com a instituição onde seu familiar recebe cuidado.</p><button class="btn btn-primary" data-action="open-modal" data-modal="request-link">Solicitar vínculo</button></div>'}</section>`; }
    if (user.role==='staff'&&!can('manageLinks')) return `${pageHeading('Solicitações de vínculo','Esta área exige permissão de gestão de vínculos.')}<section class="panel empty-state"><strong>Acesso restrito</strong><p>Solicite ao administrador da instituição a permissão necessária.</p></section>`;
    const links=db.links.filter(link=>link.status==='pending'&&link.institutionId===user.institutionId); return `${pageHeading('Vínculos familiares','Revise as solicitações antes de conceder acesso aos registros.')}<div class="inline-notice">Ao aprovar, os familiares vinculados poderão ver os registros e mídias do residente. Confira as informações antes de decidir.</div><section class="panel"><div class="panel-heading"><div><h2>Solicitações pendentes</h2><p>${links.length} aguardando análise</p></div></div>${links.length?links.map(linkRow).join(''):'<div class="empty-state"><strong>Nenhuma solicitação pendente</strong><p>Quando uma família solicitar acesso, ela aparecerá aqui.</p></div>'}</section>`; }
  function linkRow(link) { const user=DataService.get('users',link.userId), elder=DataService.get('elders',link.elderId); return `<div class="notice-card"><span class="avatar avatar-lilac">${escapeHTML((user?.name||'?').charAt(0))}</span><div class="notice-content"><h3>${escapeHTML(user?.name||'Conta não encontrada')}</h3><p>${escapeHTML(user?.email||'')} solicita acesso ao perfil de ${escapeHTML(elder?.name||'residente')}.</p><small>Solicitado em ${formatDate(link.createdAt,true)}</small></div><div class="notice-actions"><button class="btn btn-outline" data-action="review-link" data-id="${link.id}" data-status="rejected">Recusar</button><button class="btn btn-primary" data-action="review-link" data-id="${link.id}" data-status="approved">Aprovar</button></div></div>`; }
  function restrictedPage(title) { return `${pageHeading(title,'Somente o administrador da equipe pode acessar esta área.')}<section class="panel empty-state"><strong>Acesso restrito</strong><p>Peça ao administrador da instituição para realizar esta ação.</p></section>`; }
  function renderStaff() { const user=currentUser(); if (!isAdmin(user)) return restrictedPage('Equipe e permissões'); const staff=db.users.filter(item=>item.role==='staff'&&!item.isAdmin&&item.institutionId===user.institutionId); const admins=db.users.filter(item=>isAdmin(item)&&item.institutionId===user.institutionId); const inst=currentInstitution(); const keys=['viewElders','recordRoutine','recordIncident','uploadMedia','replyMessages','manageLinks']; return `${pageHeading('Equipe e permissões','Cadastre funcionários e defina quais ações cada integrante pode executar.',`<button class="btn btn-primary" data-action="open-modal" data-modal="add-staff">＋ Adicionar equipe</button>`)}<div class="inline-notice">As permissões são verificadas no JavaScript para demonstrar o fluxo. Em produção, a autorização precisa ser validada também no servidor.</div><section class="panel"><div class="panel-heading"><div><h2>Permissões da equipe</h2><p>${escapeHTML(inst?.name||'Instituição')} · administradores têm acesso total: ${admins.map(item=>escapeHTML(item.name)).join(', ')||'—'}</p></div></div><div class="table-wrap"><table class="permissions-table"><thead><tr><th>Integrante</th><th>Ver residentes</th><th>Registrar rotina</th><th>Ocorrências</th><th>Publicar mídia</th><th>Responder</th><th>Gerir vínculos</th><th>Ações</th></tr></thead><tbody>${staff.map(member=>`<tr><td>${escapeHTML(member.name)}<br><small style="color:var(--muted)">${escapeHTML(member.email)}</small></td>${keys.map(key=>`<td><input type="checkbox" aria-label="${key} para ${escapeHTML(member.name)}" data-action="permission-toggle" data-user="${member.id}" data-permission="${key}" ${member.permissions?.[key]?'checked':''}></td>`).join('')}<td><button class="text-button" data-action="delete-staff" data-id="${member.id}">Remover</button></td></tr>`).join('')||'<tr><td colspan="8">Nenhum integrante cadastrado.</td></tr>'}</tbody></table></div></section>`; }
  function renderElders() { const user=currentUser(); if (!isAdmin(user)) return restrictedPage('Residentes'); const elders=db.elders.filter(elder=>elder.institutionId===user.institutionId); return `${pageHeading('Residentes','Cadastre e mantenha os perfis dos residentes da instituição.',`<button class="btn btn-primary" data-action="open-modal" data-modal="new-elder">＋ Adicionar residente</button>`)}<div class="inline-notice">Não registre diagnósticos, prescrições ou dados médicos reais neste protótipo.</div><section class="panel"><div class="table-wrap"><table class="permissions-table"><thead><tr><th>Residente</th><th>Idade</th><th>Contato de emergência</th><th>Telefone</th><th>Familiares vinculados</th><th>Ações</th></tr></thead><tbody>${elders.map(elder=>`<tr><td>${escapeHTML(elder.name)}</td><td>${ageFrom(elder.birthDate)}</td><td>${escapeHTML(elder.emergencyContactName||'—')}</td><td>${escapeHTML(elder.emergencyContactPhone||'—')}</td><td>${elder.familyIds.length}</td><td><button class="text-button" data-action="view-elder" data-id="${elder.id}">Ver</button> · <button class="text-button" data-action="open-modal" data-modal="edit-elder" data-id="${elder.id}">Editar</button> · <button class="text-button" data-action="delete-elder" data-id="${elder.id}">Remover</button></td></tr>`).join('')||'<tr><td colspan="6">Nenhum residente cadastrado.</td></tr>'}</tbody></table></div></section>`; }
  function renderSettings() { return `${pageHeading('Preferências','Controle como os dados demonstrativos são mantidos neste navegador.')}<section class="panel"><div class="panel-heading"><div><h2>Dados e salvamento</h2><p>Por padrão, os dados existem apenas na memória desta sessão.</p></div></div><div class="settings-list"><div class="setting-row"><div><strong>Salvar dados neste navegador</strong><p>Quando ativado, o protótipo usa localStorage para manter contas e registros neste navegador após recarregar a página. Não sincroniza com outros dispositivos.</p></div><label class="switch"><input id="storage-toggle" type="checkbox" ${state.storageEnabled?'checked':''} aria-label="Salvar dados neste navegador"><span class="switch-track"></span></label></div><div class="setting-row"><div><strong>Restaurar dados de demonstração</strong><p>Descarta alterações locais e recupera os perfis e registros de exemplo.</p></div><button class="btn btn-outline" data-action="reset-demo">Restaurar</button></div><div class="setting-row"><div><strong>Limpar dados salvos</strong><p>Remove os dados deste protótipo do armazenamento local deste navegador.</p></div><button class="btn btn-outline" data-action="clear-storage">Limpar dados</button></div></div></section><section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h2>Limites do protótipo</h2><p>Antes de qualquer uso real, será necessário implementar:</p></div></div><div class="timeline"><article class="timeline-item"><span class="timeline-icon">▤</span><div><h4>Backend e API</h4><p>Centralizar autenticação, regras de acesso e operações de dados no servidor.</p></div></article><article class="timeline-item"><span class="timeline-icon peach">⌂</span><div><h4>Banco de dados</h4><p>Persistência compartilhada, integridade referencial, migrações e cópias de segurança.</p></div></article><article class="timeline-item"><span class="timeline-icon lilac">♡</span><div><h4>Privacidade e segurança</h4><p>Autorização no servidor, armazenamento seguro de mídias, registro de auditoria e adequação à LGPD.</p></div></article></div></section>`; }
  function renderProfile() { const user=currentUser(); return `${pageHeading('Meu perfil','Confira e atualize os dados da sua conta.')}<section class="panel"><form id="profile-form" class="form-grid" novalidate><div class="form-field"><label for="profile-name-input">Nome</label><input id="profile-name-input" value="${escapeHTML(user.name)}" required maxlength="150" autocomplete="name"></div><div class="form-field"><label for="profile-phone-input">Telefone (opcional)</label><input id="profile-phone-input" type="tel" inputmode="tel" value="${escapeHTML(user.phone||'')}" placeholder="(15) 99999-9999" maxlength="15" autocomplete="tel"></div><div class="form-field"><label for="profile-email-input">E-mail</label><input id="profile-email-input" value="${escapeHTML(user.email)}" disabled><small class="field-hint">O e-mail não pode ser alterado neste protótipo.</small></div><div class="form-field"><label for="profile-role-input">Perfil de acesso</label><input id="profile-role-input" value="${escapeHTML(userRoleLabel(user))}" disabled></div><div class="form-field"><label for="profile-inst-input">Instituição</label><input id="profile-inst-input" value="${escapeHTML(currentInstitution()?.name||'Não vinculada')}" disabled></div><div class="form-field full" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-primary" type="submit">Salvar alterações</button><button class="btn btn-outline" type="button" data-action="open-modal" data-modal="change-password">Alterar senha</button></div></form></section>`; }
  function showModal(title,body,actions='',eyebrow='LAÇOS') { $('#modal-title').textContent=title; $('#modal-eyebrow').textContent=eyebrow; $('#modal-body').innerHTML=body; $('#modal-actions').innerHTML=actions; $('#modal').showModal(); state.modal=title; }
  function closeModal() { $('#modal').close(); state.modal=null; }
  function modalFormField(label,idValue,type='text',placeholder='',required=true,extra='') { return `<div class="form-field"><label for="${idValue}">${label}</label><input id="${idValue}" type="${type}" placeholder="${placeholder}" ${required?'required':''} ${extra}></div>`; }
  function openModal(name,targetId) { const user=currentUser(); const elders=linkedElders(); if (name==='new-record') { if (!(can('recordRoutine')||can('recordIncident'))) return toast('Seu perfil não tem permissão para registrar a rotina.','error'); showModal('Novo registro de rotina',`<form id="new-record-form" class="form-grid"><div class="form-field full"><label for="record-elder">Residente</label><select id="record-elder" required>${elders.map(elder=>`<option value="${elder.id}">${escapeHTML(elder.name)}</option>`).join('')}</select></div><div class="form-field"><label for="record-category">Categoria</label><select id="record-category" required><option value="food">Alimentação</option><option value="wellbeing">Bem-estar geral</option><option value="activity">Atividades</option><option value="sleep">Sono e descanso</option><option value="mood">Humor</option><option value="visit">Visitas</option><option value="social">Interação social</option><option value="observation">Observações gerais</option><option value="incident">Ocorrência importante</option></select></div><div class="form-field"><label for="record-date">Data e horário</label><input id="record-date" type="datetime-local" value="${toLocalDateTimeInput()}" required></div>${modalFormField('Título do registro','record-title','text','Ex.: Atividade no jardim',true,'class="field-control"')}<div class="form-field full"><label for="record-description">Descrição</label><textarea id="record-description" placeholder="Descreva objetivamente o que foi observado..." required maxlength="1500"></textarea></div><div class="form-field full"><label for="record-observations">Observações adicionais (opcional)</label><textarea id="record-observations" placeholder="Informações complementares, sem diagnóstico médico." maxlength="1000"></textarea></div><div class="form-field full"><label class="check-label"><input id="record-priority" type="checkbox"> Marcar como ocorrência importante</label><small class="field-hint">Não registre diagnóstico, prescrição ou dados médicos neste protótipo.</small></div></form>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-record">Salvar registro</button>'); return; }
    if (name==='upload-media') { if (!can('uploadMedia')) return toast('Seu perfil não tem permissão para publicar mídias.','error'); showModal('Compartilhar momento',`<form id="upload-media-form" class="form-grid"><div class="form-field full"><label for="media-elder">Residente</label><select id="media-elder" required>${elders.map(elder=>`<option value="${elder.id}">${escapeHTML(elder.name)}</option>`).join('')}</select></div><div class="form-field"><label for="media-type">Tipo</label><select id="media-type"><option value="photo">Foto</option><option value="video">Vídeo (simulado)</option></select></div><div class="form-field"><label for="media-date">Data e horário</label><input id="media-date" type="datetime-local" value="${toLocalDateTimeInput()}" required></div><div class="form-field full"><label for="media-title">Título</label><input id="media-title" placeholder="Ex.: Tarde no jardim" required maxlength="100"></div><div class="form-field full"><label for="media-caption">Legenda</label><textarea id="media-caption" placeholder="Conte brevemente sobre este momento..." maxlength="500"></textarea></div><div class="form-field full"><label for="media-file">Arquivo de imagem (opcional)</label><input id="media-file" type="file" accept="image/*"><small class="field-hint">Prévia antes de publicar. Arquivos podem ficar apenas na memória desta sessão.</small><div id="media-preview" class="media-art hidden"></div></div></form>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-media">Publicar momento</button>'); return; }
    if (name==='request-link') { const available=db.elders.filter(elder=>!elder.familyIds.includes(user.id)); showModal('Solicitar vínculo familiar',`<form id="request-link-form" class="form-grid"><div class="form-field full"><label for="link-elder">Idoso</label><select id="link-elder" required><option value="">Selecione um residente</option>${available.map(elder=>`<option value="${elder.id}">${escapeHTML(elder.name)}</option>`).join('')}</select></div><div class="form-field full"><p class="field-hint">Instituição: ${escapeHTML(currentInstitution()?.name||'Casa Horizonte')}. O acesso só será liberado depois da aprovação da equipe ou do administrador.</p></div></form>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-link">Enviar solicitação</button>'); return; }
    if (name==='new-elder') { if (!isAdmin(user)) return toast('Somente o administrador pode criar perfis de residentes.','error'); showModal('Adicionar residente',`<form id="new-elder-form" class="form-grid">${modalFormField('Nome completo','elder-name','text','Nome do residente')}<div class="form-field"><label for="elder-birth">Data de nascimento (opcional)</label><input id="elder-birth" type="date"></div><div class="form-field"><label for="elder-contact-name">Nome do contato de emergência</label><input id="elder-contact-name" placeholder="Ex.: Mariana Oliveira" required maxlength="150" autocomplete="off"></div><div class="form-field"><label for="elder-contact-phone">Telefone do contato</label><input id="elder-contact-phone" type="tel" inputmode="tel" placeholder="(15) 99999-9999" required maxlength="15" autocomplete="off"></div><div class="form-field full"><label for="elder-observations">Observações gerais (opcional)</label><textarea id="elder-observations" placeholder="Preferências e informações gerais, sem dados médicos."></textarea></div></form>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-elder">Criar perfil</button>'); return; }
    if (name==='edit-elder') { if (!isAdmin(user)) return toast('Acesso restrito.','error'); const elder=DataService.get('elders',targetId); if (!elder||elder.institutionId!==user.institutionId) return toast('Perfil não encontrado.','error'); showModal('Editar residente',`<form id="edit-elder-form" class="form-grid">${modalFormField('Nome completo','edit-elder-name','text','Nome do residente',true,`value="${escapeHTML(elder.name)}"`)}<div class="form-field"><label for="edit-elder-birth">Data de nascimento (opcional)</label><input id="edit-elder-birth" type="date" value="${escapeHTML(elder.birthDate||'')}"></div><div class="form-field"><label for="edit-elder-contact-name">Nome do contato de emergência</label><input id="edit-elder-contact-name" value="${escapeHTML(elder.emergencyContactName||'')}" placeholder="Ex.: Mariana Oliveira" required maxlength="150" autocomplete="off"></div><div class="form-field"><label for="edit-elder-contact-phone">Telefone do contato</label><input id="edit-elder-contact-phone" type="tel" inputmode="tel" value="${escapeHTML(elder.emergencyContactPhone||'')}" placeholder="(15) 99999-9999" required maxlength="15" autocomplete="off"></div><div class="form-field full"><label for="edit-elder-observations">Observações gerais (opcional)</label><textarea id="edit-elder-observations" placeholder="Preferências e informações gerais, sem dados médicos.">${escapeHTML(elder.observations||'')}</textarea></div></form>`,`<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-elder-edit" data-id="${elder.id}">Salvar alterações</button>`); return; }
    if (name==='add-staff') { if (!isAdmin(user)) return toast('Acesso restrito.','error'); showModal('Adicionar integrante da equipe',`<form id="add-staff-form" class="form-grid">${modalFormField('Nome completo','staff-name','text','Nome do integrante')}${modalFormField('E-mail','staff-email','email','equipe@instituicao.com.br')}<div class="form-field full"><label for="staff-password">Senha de demonstração</label><input id="staff-password" type="password" placeholder="Mínimo de 6 caracteres e um número" required></div></form><p class="field-hint">A conta criada será associada à instituição atual e terá permissões mínimas; o administrador poderá ajustá-las.</p>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-staff">Criar conta</button>'); return; }
    if (name==='change-password') { showModal('Alterar senha',`<form id="change-password-form" class="form-grid" novalidate><div class="form-field full"><label for="pw-current">Senha atual</label><input id="pw-current" type="password" autocomplete="current-password" required></div><div class="form-field full"><label for="pw-new">Nova senha</label><input id="pw-new" type="password" autocomplete="new-password" placeholder="Mínimo de 6 caracteres e 1 número" required></div><div class="form-field full"><label for="pw-confirm">Confirme a nova senha</label><input id="pw-confirm" type="password" autocomplete="new-password" required></div><button type="submit" hidden>Salvar</button></form>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-password">Salvar nova senha</button>','CONTA'); return; }
    if (name==='schedule-video') { showModal('Solicitar horário de chamada',`<form id="schedule-video-form" class="form-grid"><div class="form-field"><label for="video-date">Data sugerida</label><input id="video-date" type="date" min="${new Date().toISOString().slice(0,10)}" required></div><div class="form-field"><label for="video-time">Horário sugerido</label><input id="video-time" type="time" required></div><div class="form-field full"><label for="video-note">Observação (opcional)</label><textarea id="video-note" placeholder="Alguma preferência de horário?"></textarea></div></form><p class="field-hint">O pedido é apenas registrado no protótipo; a instituição não receberá uma mensagem real.</p>`,'<button class="btn btn-outline" data-action="close-modal">Cancelar</button><button class="btn btn-primary" data-action="submit-video-request">Registrar pedido</button>'); return; }
  }
  function submitRecord() { const form=$('#new-record-form'); if (!form?.reportValidity()) return; const elderId=$('#record-elder').value, category=$('#record-category').value, title=$('#record-title').value.trim(), description=$('#record-description').value.trim(), dateTime=$('#record-date').value, observations=$('#record-observations').value.trim(), priority=$('#record-priority').checked; if (category==='incident'&&!can('recordIncident')) return toast('Seu perfil não pode registrar ocorrências importantes.','error'); const user=currentUser(), elder=DataService.get('elders',elderId); if (!elder||!canSeeElder(elder)) return toast('Você não tem acesso a este perfil.','error'); DataService.create('records',{elderId,category,title,description,dateTime,observations,priority,authorId:user.id,authorName:user.name,createdAt:new Date().toISOString()}); if (priority||category==='incident') elder.familyIds.forEach(userId=>notify(userId,'Ocorrência importante',`A equipe registrou uma atualização importante sobre ${elder.name}.`,'incident',elder.id)); if (priority||category==='incident') toast('Registro salvo e notificação importante criada.'); else toast('Registro de rotina salvo.'); closeModal(); state.page='routine'; renderWorkspace(); }
  async function submitMedia() {
    const form=$('#upload-media-form'); if (!form?.reportValidity()) return;
    const elderId=$('#media-elder').value, title=$('#media-title').value.trim(), caption=$('#media-caption').value.trim(), type=$('#media-type').value, dateTime=$('#media-date').value, file=$('#media-file').files[0];
    const elder=DataService.get('elders',elderId);
    if (!can('uploadMedia')||!elder||!canSeeElder(elder)) return toast('Você não tem permissão para publicar neste perfil.','error');
    if (isSupabaseConnected()) {
      let storageKey = null;
      if (file) {
        if (!file.type.startsWith('image/')) return toast('Selecione um arquivo de imagem válido.','error');
        if (file.size>2*1024*1024) return toast('A imagem deve ter até 2 MB neste protótipo.','error');
        storageKey = `${elderId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const {error:uploadError}=await supabaseClient.storage.from(SUPABASE_MEDIA_BUCKET).upload(storageKey,file,{upsert:false,contentType:file.type});
        if (uploadError) return remoteWriteError('Envio da mídia',uploadError);
      }
      const item=DataService.create('media',{elderId,title,caption,type,dateTime,color:['green','peach','lilac'][db.media.length%3],authorId:currentUser().id,storageKey,dataUrl:null});
      closeModal(); renderWorkspace(); toast('Momento enviado ao Supabase.');
      if (storageKey) {
        const {data,error}=await supabaseClient.storage.from(SUPABASE_MEDIA_BUCKET).createSignedUrl(storageKey,3600);
        if (!error) item.dataUrl=data?.signedUrl||null;
        renderWorkspace();
      }
      return;
    }
    const save=dataUrl=>{DataService.create('media',{elderId,title,caption,type,dateTime,color:['green','peach','lilac'][db.media.length%3],authorId:currentUser().id,dataUrl:dataUrl||null}); elder.familyIds.forEach(userId=>notify(userId,'Novo momento compartilhado',`A equipe compartilhou um momento sobre ${elder.name}.`,'media',elder.id)); closeModal(); renderWorkspace(); toast('Momento publicado no protótipo.');};
    if (file) { if (!file.type.startsWith('image/')) return toast('Selecione um arquivo de imagem válido.','error'); if (file.size>2*1024*1024) return toast('A imagem deve ter até 2 MB neste protótipo.','error'); const reader=new FileReader(); reader.onload=()=>save(reader.result); reader.onerror=()=>toast('Não foi possível ler o arquivo.','error'); reader.readAsDataURL(file); } else save(null);
  }
  function submitLink() { const form=$('#request-link-form'); if (!form?.reportValidity()) return; const user=currentUser(), elder=DataService.get('elders',$('#link-elder').value); if (!elder || !db.institutions.some(inst=>inst.id===elder.institutionId)) return toast('Selecione um residente válido desta instituição.','error'); if (db.links.some(link=>link.userId===user.id&&link.elderId===elder.id&&['pending','approved'].includes(link.status))) return toast('Você já possui uma solicitação ativa para este perfil.','error'); const link=DataService.create('links',{userId:user.id,elderId:elder.id,institutionId:elder.institutionId,status:'pending',createdAt:new Date().toISOString(),reviewedBy:null}); db.users.filter(item=>item.institutionId===elder.institutionId&&item.role==='staff').forEach(item=>notify(item.id,'Nova solicitação de vínculo',`${user.name} solicitou acesso ao perfil de ${elder.name}.`,'link',elder.id)); closeModal(); renderWorkspace(); toast('Solicitação enviada. O acesso depende da aprovação da instituição.'); }
  function submitElder() { if (!isAdmin()) return toast('Acesso restrito.','error'); const form=$('#new-elder-form'); if (!form?.reportValidity()) return; const user=currentUser(), name=$('#elder-name').value.trim(); if (!name) return toast('Informe o nome do residente.','error'); const contactName=$('#elder-contact-name').value.trim(), contactPhone=formatPhone($('#elder-contact-phone').value); if (!contactName) return toast('Informe o nome do contato de emergência.','error'); if (!validPhone(contactPhone)) return toast('Informe um telefone válido com DDD, por exemplo (15) 99999-9999.','error'); const elder=DataService.create('elders',{name,birthDate:$('#elder-birth').value||null,institutionId:user.institutionId,observations:$('#elder-observations').value.trim(),emergencyContactName:contactName,emergencyContactPhone:contactPhone,avatar:name.charAt(0).toUpperCase(),familyIds:[],createdAt:new Date().toISOString()}); closeModal(); state.activeElderId=elder.id; renderWorkspace(); toast('Perfil criado. Nenhum familiar tem acesso até um vínculo ser aprovado.'); }
  function submitStaff() { if (isSupabaseConnected()) return toast('A criação de contas de funcionários precisa de uma Edge Function/servidor para usar privilégios administrativos com segurança.','error'); if (!isAdmin()) return toast('Acesso restrito.','error'); const form=$('#add-staff-form'); if (!form?.reportValidity()) return; const name=$('#staff-name').value.trim(), email=$('#staff-email').value.trim().toLowerCase(), password=$('#staff-password').value; if (!name||!validEmail(email)||!validPassword(password)) return toast('Confira nome, e-mail e senha (6 caracteres e um número).','error'); if (db.users.some(item=>item.email.toLowerCase()===email)) return toast('Já existe uma conta com este e-mail.','error'); const user=DataService.create('users',{name,email,password,role:'staff',institutionId:currentUser().institutionId,permissions:{viewElders:true,recordRoutine:true,recordIncident:false,uploadMedia:false,replyMessages:false,manageLinks:false,manageStaff:false},createdAt:new Date().toISOString()}); closeModal(); renderWorkspace(); toast(`Conta de equipe criada para ${user.name}. Ajuste as permissões conforme necessário.`); }
  function submitElderEdit(elderId) { const form=$('#edit-elder-form'); if (!form?.reportValidity()) return; const user=currentUser(), elder=DataService.get('elders',elderId); if (!isAdmin(user)||!elder||elder.institutionId!==user.institutionId) return toast('Você não tem permissão para editar este perfil.','error'); const name=$('#edit-elder-name').value.trim(); if (!name) return toast('Informe o nome do residente.','error'); const contactName=$('#edit-elder-contact-name').value.trim(), contactPhone=formatPhone($('#edit-elder-contact-phone').value); if (!contactName) return toast('Informe o nome do contato de emergência.','error'); if (!validPhone(contactPhone)) return toast('Informe um telefone válido com DDD, por exemplo (15) 99999-9999.','error'); DataService.update('elders',elderId,{name,avatar:name.charAt(0).toUpperCase(),birthDate:$('#edit-elder-birth').value||null,emergencyContactName:contactName,emergencyContactPhone:contactPhone,observations:$('#edit-elder-observations').value.trim()}); closeModal(); renderWorkspace(); toast('Perfil do residente atualizado.'); }
  function deleteElder(elderId) { const user=currentUser(), elder=DataService.get('elders',elderId); if (!isAdmin(user)||!elder||elder.institutionId!==user.institutionId) return toast('Você não tem permissão para remover este perfil.','error'); if (!window.confirm(`Remover o perfil de ${elder.name}? Registros, mídias, mensagens e vínculos deste residente também serão removidos do protótipo.`)) return; db.records=db.records.filter(item=>item.elderId!==elderId); db.media=db.media.filter(item=>item.elderId!==elderId); db.messages=db.messages.filter(item=>item.elderId!==elderId); db.links=db.links.filter(item=>item.elderId!==elderId); db.notifications=db.notifications.filter(item=>item.elderId!==elderId); db.videoAppointments=db.videoAppointments.filter(item=>item.elderId!==elderId); DataService.remove('elders',elderId); if (state.activeElderId===elderId) state.activeElderId=linkedElders()[0]?.id||null; renderWorkspace(); toast('Perfil do residente removido.'); }
  function deleteStaff(userId) { if (isSupabaseConnected()) return toast('A remoção de contas Auth precisa ser feita por uma Edge Function segura.','error'); const user=currentUser(), member=DataService.get('users',userId); if (!member||member.role!=='staff'||member.isAdmin||!isAdmin(user)||member.institutionId!==user.institutionId) return toast('Você não tem permissão para remover este integrante.','error'); if (!window.confirm(`Remover a conta de ${member.name}?`)) return; DataService.remove('users',userId); renderWorkspace(); toast('Conta da equipe removida.'); }
  async function saveProfile(event) {
    event.preventDefault(); const user=currentUser(); if (!user) return;
    const name=$('#profile-name-input').value.trim(), phoneRaw=$('#profile-phone-input').value.trim(), phone=phoneRaw?formatPhone(phoneRaw):null;
    if (!name) return toast('Informe seu nome.','error');
    if (phone && !validPhone(phone)) return toast('Informe um telefone válido com DDD, por exemplo (15) 99999-9999.','error');
    if (isSupabaseConnected()) {
      // A RLS pode ignorar a atualização sem gerar erro; por isso conferimos as linhas devolvidas.
      const {data,error}=await supabaseClient.from('users').update({name,phone}).eq('id',user.id).select('id');
      if (error) return remoteWriteError('Atualização do perfil',error);
      if (!data?.length) return toast('Não foi possível atualizar o perfil. Confira se o SQL 04 foi executado no Supabase.','error');
      Object.assign(user,{name,phone});
    } else DataService.update('users',user.id,{name,phone});
    renderWorkspace(); toast('Perfil atualizado.');
  }
  async function submitPassword() {
    const form=$('#change-password-form'); if (!form) return; const user=currentUser();
    const current=$('#pw-current').value, next=$('#pw-new').value, confirm=$('#pw-confirm').value;
    if (!current) return toast('Informe sua senha atual.','error');
    if (!validPassword(next)) return toast('A nova senha precisa ter pelo menos 6 caracteres e um número.','error');
    if (next!==confirm) return toast('A confirmação não confere com a nova senha.','error');
    if (next===current) return toast('A nova senha precisa ser diferente da atual.','error');
    if (isSupabaseConnected()) {
      const {error:authError}=await supabaseClient.auth.signInWithPassword({email:user.email,password:current});
      if (authError) return toast('A senha atual está incorreta.','error');
      const {error}=await supabaseClient.auth.updateUser({password:next});
      if (error) return toast(error.message||'Não foi possível alterar a senha.','error');
    } else {
      if (user.password!==current) return toast('A senha atual está incorreta.','error');
      DataService.update('users',user.id,{password:next});
    }
    closeModal(); toast('Senha alterada com sucesso.');
  }
  function submitVideoRequest() { const form=$('#schedule-video-form'); if (!form?.reportValidity()) return; const date=$('#video-date').value, time=$('#video-time').value; DataService.create('videoAppointments',{userId:currentUser().id,elderId:state.activeElderId,date,time,note:$('#video-note').value.trim(),status:'pending',createdAt:new Date().toISOString()}); closeModal(); toast('Pedido de horário registrado no protótipo; nenhuma solicitação real foi enviada.'); }
  function reviewLink(linkId,status) { const link=DataService.get('links',linkId); if (!link||link.status!=='pending') return; const user=currentUser(); if (!(user.role==='staff'&&can('manageLinks')&&user.institutionId===link.institutionId)) return toast('Você não tem permissão para revisar este vínculo.','error'); const elder=DataService.get('elders',link.elderId), family=DataService.get('users',link.userId); DataService.update('links',linkId,{status,reviewedBy:user.id,reviewedAt:new Date().toISOString()}); if (status==='approved'&&elder&&!elder.familyIds.includes(link.userId)) elder.familyIds.push(link.userId); if (status==='rejected'&&elder) elder.familyIds=elder.familyIds.filter(idValue=>idValue!==link.userId); persistIfEnabled(); notify(link.userId,status==='approved'?'Vínculo aprovado':'Solicitação de vínculo recusada',status==='approved'?`A instituição aprovou seu acesso ao perfil de ${elder?.name||'seu familiar'}.`:`A instituição não aprovou a solicitação de vínculo para ${elder?.name||'o perfil selecionado'}.`,'link',elder?.id); toast(status==='approved'?'Vínculo aprovado. A família agora pode acessar os registros.':'Solicitação recusada.'); renderWorkspace(); }
  async function togglePermission(userId,permission,checked) {
    const user=currentUser(), member=DataService.get('users',userId);
    if (!member||member.role!=='staff'||member.isAdmin||!(isAdmin(user)&&member.institutionId===user.institutionId)) return toast('Você não tem permissão para alterar este acesso.','error');
    if (isSupabaseConnected()) {
      const {error}=await supabaseClient.rpc('admin_set_staff_permission',{p_user_id:userId,p_permission:permission,p_enabled:checked});
      if (error) return remoteWriteError('Atualização de permissão',error);
    }
    member.permissions=member.permissions||{}; member.permissions[permission]=checked; persistIfEnabled(); toast('Permissão atualizada.');
  }
  function applyRoutineFilters() { const query=($('#routine-search')?.value||'').trim().toLowerCase(), elder=$('#routine-elder-filter')?.value||'all', category=$('#routine-category-filter')?.value||'all', date=$('#routine-date-filter')?.value||''; const cards=$$('#routine-record-list .record-card'); let visible=0; cards.forEach(card=>{const show=(!query||card.dataset.search.includes(query))&&(elder==='all'||card.dataset.elderId===elder)&&(category==='all'||card.dataset.category===category)&&(!date||card.dataset.date>=date); card.classList.toggle('hidden',!show); if(show)visible++;}); const list=$('#routine-record-list'); let empty=$('#routine-filter-empty'); if (!visible) { if(!empty){empty=document.createElement('div');empty.id='routine-filter-empty';empty.className='empty-state';empty.innerHTML='<strong>Nenhum registro encontrado</strong><p>Altere os filtros ou tente outra busca.</p>';list.append(empty);} } else empty?.remove(); }
  function applyMediaFilters() { const elder=$('#media-elder-filter')?.value||'all', type=$('#media-type-filter')?.value||'all'; $$('#media-list .media-card').forEach(card=>card.classList.toggle('hidden',!(elder==='all'||card.dataset.elderId===elder)||!(type==='all'||card.dataset.type===type))); }
  function viewElder(elderId) { const elder=DataService.get('elders',elderId); if (!elder||!canSeeElder(elder)) return toast('O vínculo precisa estar aprovado para acessar esse perfil.','error'); const inst=DataService.get('institutions',elder.institutionId); const records=db.records.filter(item=>item.elderId===elder.id).sort((a,b)=>new Date(b.dateTime)-new Date(a.dateTime)).slice(0,5); const media=db.media.filter(item=>item.elderId===elder.id).slice(0,3); const body=`<div style="display:flex;align-items:center;gap:14px;margin-bottom:20px"><div class="elder-photo">${escapeHTML(elder.avatar||elder.name.charAt(0))}</div><div><h3 style="margin:0 0 4px">${escapeHTML(elder.name)}</h3><p style="margin:0;font-size:.78rem">${ageFrom(elder.birthDate)}</p></div></div><div class="modal-detail-grid"><div class="detail-tile"><small>Instituição</small><strong>${escapeHTML(inst?.name||'—')}</strong></div><div class="detail-tile"><small>Data de nascimento</small><strong>${elder.birthDate?formatDate(`${elder.birthDate}T12:00:00`):'Não informada'}</strong></div></div><h3 style="margin:20px 0 8px;font-size:.9rem">Observações gerais</h3><p>${escapeHTML(elder.observations||'Nenhuma observação geral registrada.')}</p><h3 style="margin:20px 0 8px;font-size:.9rem">Contato de emergência</h3><p>${escapeHTML(emergencyContactText(elder)||'Não informado')}</p><h3 style="margin:20px 0 8px;font-size:.9rem">Registros recentes</h3>${records.map(recordTimelineItem).join('')||'<p>Nenhum registro publicado.</p>'}<h3 style="margin:20px 0 8px;font-size:.9rem">Momentos compartilhados</h3>${media.length?`<div class="media-grid">${media.map(mediaCard).join('')}</div>`:'<p>Nenhuma mídia compartilhada.</p>'}`; showModal('Perfil do residente',body,'<button class="btn btn-outline" data-action="close-modal">Fechar</button><button class="btn btn-primary" data-action="navigate-elder" data-page="routine" data-id="'+elder.id+'">Ver histórico completo</button>'); }
  function resetDemo() { if (isSupabaseConnected()) return toast('Os dados de demonstração locais não podem sobrescrever o Supabase. Gerencie os dados no banco.','error'); const confirmed=window.confirm('Restaurar os dados de demonstração? Suas alterações neste protótipo serão descartadas.'); if(!confirmed)return; db=structuredCloneSafe(seed); state.storageEnabled=false; try{localStorage.removeItem(STORAGE_KEY);}catch{} state.page='dashboard'; renderWorkspace(); toast('Dados de demonstração restaurados.'); }
  function clearStorage() { if (isSupabaseConnected()) return toast('Os dados desta aplicação estão no Supabase; nada foi removido do banco.','error'); try{localStorage.removeItem(STORAGE_KEY);}catch{} state.storageEnabled=false; db.settings.storageEnabled=false; toast('Dados salvos removidos deste navegador. A sessão atual continua ativa.'); renderPage(); }
  function runSelfTests() { const tests=[]; const assert=(name,condition)=>{tests.push({name,passed:Boolean(condition)}); console.assert(condition,`Teste Laços: ${name}`);}; assert('valida e-mail válido',validEmail('teste@exemplo.com')); assert('rejeita e-mail sem domínio',!validEmail('teste@')); assert('senha válida com seis caracteres e dígito',validPassword('abcde1')); assert('rejeita senha sem dígito',!validPassword('abcdef')); assert('rejeita senha curta',!validPassword('a1')); assert('categoria tem nome legível',categoryName('activity')==='Atividades'); assert('existe apenas uma instituição fixa',db.institutions.length===1&&DataService.get('institutions','inst-1')?.name==='Casa Horizonte'); assert('todos os residentes pertencem à instituição fixa',db.elders.every(elder=>elder.institutionId==='inst-1')); assert('dados demonstrativos incluem pelo menos um vínculo aprovado',db.links.some(link=>link.status==='approved')); assert('existe conta de administrador dentro da equipe',db.users.some(user=>user.role==='staff'&&user.isAdmin)); assert('não existem perfis manager/admin separados',!db.users.some(user=>['manager','admin'].includes(user.role))); console.info(`[Laços] ${tests.filter(test=>test.passed).length}/${tests.length} testes básicos passaram.`,tests); }

  document.addEventListener('click',event=>{ const control=event.target.closest('[data-action]'); if (!control) return; const action=control.dataset.action; if (action!=='toggle-account-menu') closeAccountMenu(); if (control.tagName==='A'&&control.getAttribute('href')==='#inicio') { event.preventDefault(); } switch(action) {
    case 'show-public': showPublic(); break; case 'show-login': showAuth('login'); break; case 'show-signup': showAuth('signup'); break; case 'logout': logout(); break; case 'navigate': navigate(control.dataset.page); break; case 'navigate-elder': state.activeElderId=control.dataset.id; closeModal(); navigate(control.dataset.page); break; case 'toggle-sidebar': $('#sidebar').classList.toggle('open'); break; case 'toggle-password': { const input=$('#'+control.dataset.target); input.type=input.type==='password'?'text':'password'; control.setAttribute('aria-label',input.type==='password'?'Mostrar senha':'Ocultar senha'); break; } case 'demo-login': { if (isSupabaseConnected()) { toast('Entre com uma conta criada no Supabase Auth. Os logins demonstrativos locais estão desativados.','error'); break; } const user=db.users.find(item=>item.role===control.dataset.role&&!item.isAdmin); if(user)login(user); else toast('Perfil demonstrativo não encontrado.','error'); break; } case 'open-modal': openModal(control.dataset.modal,control.dataset.id); break; case 'close-modal': closeModal(); break; case 'view-elder': viewElder(control.dataset.id); break; case 'review-link': reviewLink(control.dataset.id,control.dataset.status); break; case 'select-conversation': state.activeElderId=control.dataset.id; renderPage(); break; case 'mark-read': { DataService.update('notifications',control.dataset.id,{read:true}); renderWorkspace(); break; } case 'mark-all-read': { db.notifications.filter(item=>item.userId===currentUser().id).forEach(item=>{item.read=true; if(isSupabaseConnected()) persistRemoteUpdate('notifications',item.id,{read:true});}); persistIfEnabled(); renderWorkspace(); toast('Todas as notificações foram marcadas como lidas.'); break; } case 'toggle-mic': state.video.mic=!state.video.mic; renderPage(); break; case 'toggle-camera': state.video.camera=!state.video.camera; renderPage(); break; case 'start-video': state.video.status='calling'; renderPage(); toast('Chamada simulada iniciada. Nenhum dispositivo foi acessado.'); break; case 'end-video': state.video.status='ended'; renderPage(); toast('Chamada simulada encerrada.'); break; case 'submit-record': submitRecord(); break; case 'submit-media': submitMedia(); break; case 'submit-link': submitLink(); break; case 'submit-elder': submitElder(); break; case 'submit-elder-edit': submitElderEdit(control.dataset.id); break; case 'delete-elder': deleteElder(control.dataset.id); break; case 'delete-staff': deleteStaff(control.dataset.id); break; case 'submit-staff': submitStaff(); break; case 'submit-video-request': submitVideoRequest(); break; case 'delete-media': { if(!can('uploadMedia'))return toast('Permissão insuficiente.','error'); if(window.confirm('Remover esta mídia do protótipo?')){const item=DataService.get('media',control.dataset.id); if(isSupabaseConnected()&&item?.storageKey) void supabaseClient.storage.from(SUPABASE_MEDIA_BUCKET).remove([item.storageKey]).then(({error})=>{if(error)remoteWriteError('Remoção do arquivo',error);}); DataService.remove('media',control.dataset.id);renderWorkspace();toast('Mídia removida.');} break; } case 'open-profile': navigate('profile'); break; case 'toggle-account-menu': toggleAccountMenu(); break; case 'account-profile': navigate('profile'); break; case 'account-password': openModal('change-password'); break; case 'submit-password': submitPassword(); break; case 'reset-demo': resetDemo(); break; case 'clear-storage': clearStorage(); break;
  }});
  document.addEventListener('submit',event=>{ switch(event.target.id){case 'login-form':handleLogin(event);break;case 'signup-form':handleSignup(event);break;case 'message-form':handleMessage(event);break;case 'profile-form':saveProfile(event);break;case 'change-password-form':event.preventDefault();submitPassword();break;} });
  document.addEventListener('input',event=>{ if (['elder-contact-phone','edit-elder-contact-phone','profile-phone-input'].includes(event.target.id)) event.target.value=formatPhone(event.target.value); if (event.target.closest('#routine-search')||event.target.closest('#routine-date-filter')) applyRoutineFilters(); if(event.target.id==='media-file'){ const file=event.target.files[0],preview=$('#media-preview'); if(file&&file.type.startsWith('image/')&&file.size<=2*1024*1024){const reader=new FileReader();reader.onload=()=>{preview.innerHTML=`<img src="${reader.result}" alt="Prévia da imagem" style="width:100%;height:180px;object-fit:contain">`;preview.classList.remove('hidden');};reader.readAsDataURL(file);}else{preview.classList.add('hidden');preview.innerHTML='';}} });
  document.addEventListener('change',event=>{ if(event.target.id==='routine-elder-filter'||event.target.id==='routine-category-filter')applyRoutineFilters(); if(event.target.id==='media-elder-filter'||event.target.id==='media-type-filter')applyMediaFilters(); if(event.target.id==='storage-toggle')setStorageEnabled(event.target.checked); if(event.target.matches('[data-action="permission-toggle"]'))togglePermission(event.target.dataset.user,event.target.dataset.permission,event.target.checked); });
  document.addEventListener('click',event=>{ if (!event.target.closest('.account-menu')) closeAccountMenu(); });
  document.addEventListener('keydown',event=>{ if (event.key==='Escape' && !$('#account-menu')?.classList.contains('hidden')) { toggleAccountMenu(false); $('#topbar-avatar')?.focus(); } });
  $('#modal').addEventListener('click',event=>{if(event.target===$('#modal'))closeModal();});
  $('#login-form').addEventListener('reset',()=>clearValidation($('#login-form')));
  async function startApplication() {
    if (!isSupabaseConfigured()) {
      loadStorage(); runSelfTests();
      console.info('[Laços] Para conectar ao Supabase, preencha SUPABASE_URL e SUPABASE_KEY no início de script.js. O protótipo permanece em modo local enquanto estiverem vazios.');
      return;
    }
    try {
      await loadSupabaseLibrary();
      supabaseClient = window.supabase.createClient(SUPABASE_URL.trim(), SUPABASE_KEY.trim(), {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      state.storageEnabled = false;
      const {data,error}=await supabaseClient.auth.getSession();
      if (error) throw error;
      if (data.session?.user) await loadRemoteWorkspace(data.session.user);
      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && state.user) { state.user=null; remoteCurrentUserId=null; showPublic(); }
      });
      // Os testes internos antigos assumem os dados locais de demonstração.
      console.info('[Laços/Supabase] Conectado. Dados e permissões vêm do Supabase.');
    } catch (error) {
      console.error('[Laços/Supabase] Falha de inicialização:',error);
      showPublic();
      toast('Não foi possível conectar ao Supabase. Confira a URL, a chave e o arquivo SQL de configuração.','error');
    }
  }

  void startApplication();
})();

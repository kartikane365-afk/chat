import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, Send, User, Lock, Loader2, LogOut, Search, Trash2, Paperclip, Settings, File, Image as ImageIcon, Video, Mic, Square, Zap, Shield, AlertTriangle } from 'lucide-react';
import { generateKeyPair, encryptMessage, decryptMessage, encryptFile, decryptFile } from './crypto';
import { auth, db } from './firebase';
import { 
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword
} from 'firebase/auth';
import { 
  collection, doc, setDoc, getDoc, getDocs, query, where, orderBy, onSnapshot,
  addDoc, serverTimestamp, updateDoc, arrayUnion, writeBatch, deleteDoc
} from 'firebase/firestore';

const getChatId = (uid1, uid2) => [uid1, uid2].sort().join('_');

// --- Helper Functions for Database Storage Workaround ---
const fileToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => resolve(reader.result.split(',')[1]);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const compressImage = (file) => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_DIM = 800;
      let { width, height } = img;
      if (width > height) { if (width > MAX_DIM) { height *= MAX_DIM / width; width = MAX_DIM; } } 
      else { if (height > MAX_DIM) { width *= MAX_DIM / height; height = MAX_DIM; } }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.6);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

// --- Attachment Viewer ---
const AttachmentViewer = ({ attachmentInfo }) => {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadFile = async () => {
    setLoading(true);
    try {
      const byteCharacters = atob(attachmentInfo.data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
      const encryptedBlob = new Blob([new Uint8Array(byteNumbers)]);
      const decryptedBlob = await decryptFile(encryptedBlob, attachmentInfo.key, attachmentInfo.mime);
      setBlobUrl(URL.createObjectURL(decryptedBlob));
    } catch(err) { alert("Failed to decrypt file."); }
    setLoading(false);
  };

  if (blobUrl) {
    if (attachmentInfo.mime.startsWith('image/')) return <img src={blobUrl} alt={attachmentInfo.name} className="max-w-full h-auto rounded-xl max-h-[300px]" />;
    if (attachmentInfo.mime.startsWith('video/')) return <video src={blobUrl} controls className="max-w-full rounded-xl max-h-[300px]" />;
    if (attachmentInfo.mime.startsWith('audio/')) return <audio src={blobUrl} controls className="w-full max-w-[250px] custom-audio" />;
    return <a href={blobUrl} download={attachmentInfo.name} className="text-cyan-400 hover:text-cyan-300 underline font-semibold flex items-center gap-1"><File size={16}/> Download</a>;
  }

  const FileIcon = attachmentInfo.mime.startsWith('image/') ? ImageIcon : (attachmentInfo.mime.startsWith('video/') ? Video : (attachmentInfo.mime.startsWith('audio/') ? Mic : File));

  return (
    <button onClick={loadFile} disabled={loading} className="bg-neutral-800/50 hover:bg-neutral-800 border border-white/10 px-4 py-3 rounded-2xl text-sm flex items-center gap-3 w-full max-w-sm text-left transition-all">
      <div className="bg-violet-500/20 text-violet-400 p-2 rounded-full">
        {loading ? <Loader2 className="animate-spin" size={20}/> : <FileIcon size={20} />}
      </div>
      <div className="flex-1 overflow-hidden">
        <p className="font-medium text-neutral-200 truncate">{attachmentInfo.name === 'voice_message.webm' ? 'Voice Note' : attachmentInfo.name}</p>
        <p className="text-xs text-neutral-400">Encrypted • Tap to open</p>
      </div>
    </button>
  );
};

// --- Avatar Component ---
const Avatar = ({ user, size = "md" }) => {
  const dimensions = size === "lg" ? "w-24 h-24 text-4xl" : (size === "sm" ? "w-10 h-10 text-lg" : "w-12 h-12 text-xl");
  if (user?.avatar) return <img src={user.avatar} alt="avatar" className={`${dimensions} rounded-full object-cover shadow-lg border border-white/10`} />;
  return (
    <div className={`${dimensions} rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center text-white font-bold shadow-lg border border-white/10`}>
      {user?.username ? user.username[0].toUpperCase() : '?'}
    </div>
  );
};

// --- Main App ---
function App() {
  const [currentUser, setCurrentUser] = useState(null); 
  const [sessionKeys, setSessionKeys] = useState(null); 
  const [users, setUsers] = useState([]); 
  const [activeChat, setActiveChat] = useState(null); 
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');

  const [isLogin, setIsLogin] = useState(true);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  
  const [initialLoad, setInitialLoad] = useState(true);
  const [uploadingFile, setUploadingFile] = useState(false);
  
  const [showSettings, setShowSettings] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  // Admin State
  const [showAdmin, setShowAdmin] = useState(false);
  const [allNetworkUsers, setAllNetworkUsers] = useState([]);

  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const avatarInputRef = useRef(null);

  const [chatPartners, setChatPartners] = useState([]);
  const [partnerStatus, setPartnerStatus] = useState({ typing: false, online: false });

  // Admin Effect - Load all users when console opens
  useEffect(() => {
    if (showAdmin && currentUser?.username === 'kartikane') {
      const fetchAllUsers = async () => {
        try {
          const snapshot = await getDocs(collection(db, "users"));
          setAllNetworkUsers(snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() })));
        } catch (e) {
          console.error("Admin fetch failed", e);
        }
      };
      fetchAllUsers();
    }
  }, [showAdmin, currentUser]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const username = user.email.split('@')[0];
        const privKey = JSON.parse(localStorage.getItem(`privkey_${username}`));
        
        let profile = { username };
        try {
          const userDoc = await getDoc(doc(db, "users", user.uid));
          if (userDoc.exists()) profile = userDoc.data();
          else if (username !== 'kartikane') {
             // If user doc doesn't exist, they were banned! Log them out.
             signOut(auth);
             return;
          }
        } catch (e) {}

        setCurrentUser({ uid: user.uid, ...profile });
        setSessionKeys(privKey ? { privateKeyJwk: privKey } : null);

        const savedContacts = JSON.parse(localStorage.getItem(`contacts_${username}`)) || [];
        setUsers(savedContacts);
      } else {
        setCurrentUser(null); setSessionKeys(null); setUsers([]); setActiveChat(null); setShowAdmin(false);
      }
      setInitialLoad(false);
    });
    return () => unsubscribe();
  }, []);

  // Presence & Chat Partners Listener
  useEffect(() => {
    if (!currentUser) return;
    const updatePresence = () => updateDoc(doc(db, "users", currentUser.uid), { lastSeen: Date.now() }).catch(()=>null);
    updatePresence();
    const heartbeat = setInterval(updatePresence, 60000);

    const unsubSelf = onSnapshot(doc(db, "users", currentUser.uid), (docSnap) => {
       if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.chatPartners) setChatPartners(data.chatPartners);
       }
    });

    return () => { clearInterval(heartbeat); unsubSelf(); };
  }, [currentUser?.uid]);

  // Fetch missing partners
  useEffect(() => {
    if (!currentUser || chatPartners.length === 0) return;
    const loadPartners = async () => {
       const currentList = [...users];
       let updated = false;
       for (const uid of chatPartners) {
          if (!currentList.find(u => u.uid === uid)) {
             const snap = await getDoc(doc(db, "users", uid));
             if (snap.exists()) {
                currentList.push({ uid, ...snap.data() });
                updated = true;
             }
          }
       }
       if (updated) {
          setUsers(currentList);
          localStorage.setItem(`contacts_${currentUser.username}`, JSON.stringify(currentList));
       }
    };
    loadPartners();
  }, [chatPartners]);

  // Active Chat Listener
  useEffect(() => {
    if (!activeChat || !currentUser || !sessionKeys) return;
    
    const unsubPartner = onSnapshot(doc(db, "users", activeChat.uid), (docSnap) => {
       if (docSnap.exists()) {
          const data = docSnap.data();
          setPartnerStatus({
             typing: data.typingTo === currentUser.uid,
             online: data.lastSeen && (Date.now() - data.lastSeen < 120000)
          });
          if (data.avatar !== activeChat.avatar) setActiveChat(prev => ({...prev, avatar: data.avatar}));
       } else {
          // They were banned and deleted from the DB
          setActiveChat(prev => ({...prev, username: "[Deleted User]", banned: true}));
       }
    });

    setMessages([]);
    setChatSearchQuery('');
    const chatId = getChatId(currentUser.uid, activeChat.uid);
    const q = query(collection(db, "messages"), where("chatId", "==", chatId), orderBy("timestamp", "asc"));

    const unsubMessages = onSnapshot(q, async (snapshot) => {
      const msgs = [];
      for (const document of snapshot.docs) {
        const data = document.data();
        if (data.deletedBy && data.deletedBy.includes(currentUser.uid)) continue;

        let text = '';
        try {
          if (data.senderId === currentUser.uid) {
            text = data.encryptedForSender ? await decryptMessage(data.encryptedForSender, sessionKeys.privateKeyJwk) : "[Old Message]";
          } else {
            text = data.encryptedForReceiver ? await decryptMessage(data.encryptedForReceiver, sessionKeys.privateKeyJwk) : (data.encryptedContent ? await decryptMessage(data.encryptedContent, sessionKeys.privateKeyJwk) : "[Decryption Failed]");
            if (!data.read) updateDoc(doc(db, "messages", document.id), { read: true }).catch(()=>null);
          }
        } catch (err) { text = "[Decryption Failed]"; }

        msgs.push({ id: document.id, ...data, text });
      }
      setMessages(msgs);
    });

    return () => { unsubPartner(); unsubMessages(); };
  }, [activeChat, currentUser, sessionKeys]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatSearchQuery]);

  useEffect(() => {
    if (!currentUser) return;
    const typingStatus = newMessage.length > 0 && activeChat ? activeChat.uid : null;
    updateDoc(doc(db, "users", currentUser.uid), { typingTo: typingStatus }).catch(()=>null);
  }, [newMessage, activeChat, currentUser]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthLoading(true); setAuthError('');
    const fakeEmail = `${authUsername.toLowerCase()}@nexuschat.local`;

    try {
      if (isLogin) await signInWithEmailAndPassword(auth, fakeEmail, authPassword);
      else {
        const { publicKeyJwk, privateKeyJwk } = await generateKeyPair();
        localStorage.setItem(`privkey_${authUsername.toLowerCase()}`, JSON.stringify(privateKeyJwk));
        const userCredential = await createUserWithEmailAndPassword(auth, fakeEmail, authPassword);
        await setDoc(doc(db, "users", userCredential.user.uid), {
          username: authUsername, public_key: publicKeyJwk, avatar: null, typingTo: null, chatPartners: [], lastSeen: Date.now()
        });
      }
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') setAuthError('Username already taken.');
      else if (err.code === 'auth/invalid-credential') setAuthError('Invalid credentials.');
      else setAuthError(err.message);
    } finally { setAuthLoading(false); }
  };

  const handleAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 200;
        let width = img.width; let height = img.height;
        if (width > height) { if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } } 
        else { if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; } }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        try {
          await updateDoc(doc(db, "users", currentUser.uid), { avatar: dataUrl });
          setCurrentUser(prev => ({...prev, avatar: dataUrl}));
        } catch (err) { alert("Failed to update profile picture."); }
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSearchUser = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim() || !currentUser) return;
    if (searchQuery.toLowerCase() === currentUser.username.toLowerCase()) { alert("You cannot chat with yourself!"); setSearchQuery(''); return; }
    setIsSearching(true);
    try {
      const q = query(collection(db, "users"), where("username", "==", searchQuery.trim()));
      const querySnapshot = await getDocs(q);
      if (querySnapshot.empty) alert("No user found with that exact username!");
      else {
        const foundUser = { uid: querySnapshot.docs[0].id, ...querySnapshot.docs[0].data() };
        if (!users.find(u => u.uid === foundUser.uid)) {
          const updatedUsers = [foundUser, ...users];
          setUsers(updatedUsers);
          localStorage.setItem(`contacts_${currentUser.username}`, JSON.stringify(updatedUsers));
        }
        setActiveChat(foundUser);
        setSearchQuery('');
      }
    } catch (err) { alert("Failed to search."); } finally { setIsSearching(false); }
  };

  const sendPayloadToFirestore = async (plainTextString) => {
    try {
      const encryptedForReceiver = await encryptMessage(plainTextString, activeChat.public_key);
      const encryptedForSender = await encryptMessage(plainTextString, currentUser.public_key);
      const chatId = getChatId(currentUser.uid, activeChat.uid);

      await addDoc(collection(db, "messages"), {
        chatId, senderId: currentUser.uid, receiverId: activeChat.uid,
        encryptedForReceiver, encryptedForSender, deletedBy: [], read: false, timestamp: serverTimestamp()
      });

      updateDoc(doc(db, "users", currentUser.uid), { chatPartners: arrayUnion(activeChat.uid) }).catch(()=>null);
      updateDoc(doc(db, "users", activeChat.uid), { chatPartners: arrayUnion(currentUser.uid) }).catch(()=>null);

    } catch (err) { alert("Failed to send securely."); }
  };

  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    if (!newMessage.trim() || !activeChat || !currentUser || activeChat.banned) return;
    const textToSend = newMessage;
    setNewMessage('');
    setMessages(prev => [...prev, { id: Date.now().toString() + "_temp", senderId: currentUser.uid, text: textToSend, timestamp: new Date(), read: false }]);
    await sendPayloadToFirestore(textToSend);
  };

  const uploadAttachment = async (rawFile, fileName, mimeType) => {
    if (activeChat.banned) return;
    setUploadingFile(true);
    try {
      let finalBlob = rawFile;
      if (mimeType.startsWith('image/')) {
         finalBlob = await compressImage(rawFile);
         fileName = fileName.replace(/\.[^/.]+$/, "") + ".jpg";
         mimeType = 'image/jpeg';
      }
      if (finalBlob.size > 700 * 1024) { alert("File is too large!"); setUploadingFile(false); return; }
      
      const { encryptedBlob, keyBase64 } = await encryptFile(finalBlob);
      const encryptedBase64 = await fileToBase64(encryptedBlob);
      const attachmentData = { type: "FILE", data: encryptedBase64, key: keyBase64, name: fileName, mime: mimeType };
      const textToSend = `[ATTACHMENT]:${JSON.stringify(attachmentData)}`;

      setMessages(prev => [...prev, { id: Date.now().toString() + "_temp", senderId: currentUser.uid, text: textToSend, timestamp: new Date(), read: false }]);
      await sendPayloadToFirestore(textToSend);
    } catch (err) { alert("Failed to send attachment."); } finally { setUploadingFile(false); }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file || !activeChat || !currentUser) return;
    uploadAttachment(file, file.name, file.type);
    if (fileInputRef.current) fileInputRef.current.value = null;
  };

  const startRecording = async () => {
    if (activeChat.banned) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = e => { if(e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) { alert("Microphone access denied."); }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.onstop = () => uploadAttachment(new Blob(audioChunksRef.current, { type: 'audio/webm' }), "voice_message.webm", "audio/webm");
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };

  const handleDeleteMessage = async (msgId) => {
    if (!window.confirm("Delete this message for yourself?")) return;
    try { await updateDoc(doc(db, "messages", msgId), { deletedBy: arrayUnion(currentUser.uid) }); } 
    catch (err) { alert("Failed to delete message."); }
  };

  const handleDeleteEntireChat = async () => {
    if (!window.confirm("Are you sure you want to delete this entire chat for yourself?")) return;
    try {
      const batch = writeBatch(db);
      messages.forEach(msg => {
        if (!msg.id.endsWith('_temp')) batch.update(doc(db, "messages", msg.id), { deletedBy: arrayUnion(currentUser.uid) });
      });
      await batch.commit();
      setMessages([]);
    } catch (err) { alert("Failed to clear chat."); }
  };

  // --- Admin Functions ---
  const handleBanUser = async (targetUser) => {
    if (targetUser.uid === currentUser.uid) { alert("You cannot ban yourself."); return; }
    if (!window.confirm(`Are you sure you want to PERMANENTLY BAN and delete the profile of ${targetUser.username}?`)) return;
    try {
       // Delete their user document. This effectively prevents them from logging in, destroys their public key, and prevents anyone from messaging them.
       await deleteDoc(doc(db, "users", targetUser.uid));
       setAllNetworkUsers(prev => prev.filter(u => u.uid !== targetUser.uid));
       alert(`User ${targetUser.username} has been permanently eradicated from the network.`);
    } catch (e) {
       console.error("Ban failed", e);
       alert("Failed to ban user. Make sure your database rules allow deletions.");
    }
  };

  if (initialLoad) return <div className="min-h-screen bg-neutral-950 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={32} /></div>;

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-violet-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-neutral-900/50 backdrop-blur-xl rounded-3xl shadow-2xl p-8 border border-white/10 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-violet-500 to-cyan-500"></div>
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-violet-600/20 text-violet-400 mb-4 shadow-[0_0_30px_rgba(139,92,246,0.3)]"><Zap size={32} /></div>
            <h1 className="text-3xl font-bold text-white tracking-tight">Nexus</h1>
            <p className="text-neutral-400 text-sm mt-1">E2EE GenZ Chat</p>
          </div>
          <form onSubmit={handleAuth} className="space-y-4">
            <input type="text" required placeholder="Username" className="w-full px-5 py-4 border border-white/5 bg-neutral-950/50 text-white rounded-2xl focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all placeholder-neutral-500" value={authUsername} onChange={e => setAuthUsername(e.target.value)} />
            <input type="password" required placeholder="Password" className="w-full px-5 py-4 border border-white/5 bg-neutral-950/50 text-white rounded-2xl focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all placeholder-neutral-500" value={authPassword} onChange={e => setAuthPassword(e.target.value)} />
            {authError && <div className="p-3 rounded-xl text-sm bg-red-500/10 text-red-400 border border-red-500/20">{authError}</div>}
            <button type="submit" disabled={authLoading} className="w-full bg-gradient-to-r from-violet-600 to-indigo-600 text-white py-4 rounded-2xl font-bold hover:shadow-[0_0_20px_rgba(139,92,246,0.4)] flex items-center justify-center transition-all">
              {authLoading ? <Loader2 className="animate-spin" size={20} /> : (isLogin ? 'Enter Nexus' : 'Create Account')}
            </button>
          </form>
          <div className="mt-6 text-center text-sm text-neutral-400">
            {isLogin ? "New here? " : "Already stealth? "}
            <button onClick={() => setIsLogin(!isLogin)} className="text-violet-400 font-bold hover:text-violet-300 transition-colors">{isLogin ? 'Sign up' : 'Log in'}</button>
          </div>
        </div>
      </div>
    );
  }

  if (currentUser && !sessionKeys) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-neutral-900 border border-white/10 rounded-3xl p-8 text-center">
          <Lock size={48} className="mx-auto text-red-500 mb-4" />
          <h2 className="text-xl font-bold mb-2 text-white">Encryption Key Missing</h2>
          <p className="text-neutral-400 mb-6">Device not recognized. Log out and create a new identity.</p>
          <button onClick={() => signOut(auth)} className="bg-neutral-800 text-white px-6 py-3 rounded-2xl font-medium hover:bg-neutral-700 transition-colors">Log Out</button>
        </div>
      </div>
    );
  }

  const filteredMessages = messages.filter(msg => {
    if (!chatSearchQuery.trim()) return true;
    if (!msg.text) return false;
    if (msg.text.startsWith('[ATTACHMENT]:')) {
      try { return JSON.parse(msg.text.substring(13)).name.toLowerCase().includes(chatSearchQuery.toLowerCase()); } catch { return false; }
    }
    return msg.text.toLowerCase().includes(chatSearchQuery.toLowerCase());
  });

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100 selection:bg-violet-500/30">
      
      {/* Admin Modal */}
      {showAdmin && currentUser.username === 'kartikane' && (
        <div className="absolute inset-0 bg-black/90 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-neutral-950 rounded-3xl p-8 w-full max-w-2xl shadow-2xl border border-red-500/30">
            <div className="flex items-center gap-3 mb-6 border-b border-white/10 pb-4">
              <Shield className="text-red-500" size={32} />
              <h2 className="text-2xl font-bold text-white tracking-widest uppercase">Admin God Console</h2>
            </div>
            
            <div className="max-h-[50vh] overflow-y-auto mb-6 space-y-2 pr-2">
              {allNetworkUsers.map(u => (
                <div key={u.uid} className="flex items-center justify-between p-3 bg-neutral-900 rounded-xl border border-white/5">
                  <div className="flex items-center gap-3">
                     <Avatar user={u} size="sm" />
                     <div>
                       <p className="font-bold text-neutral-200">{u.username}</p>
                       <p className="text-[10px] text-neutral-500 font-mono">{u.uid}</p>
                     </div>
                  </div>
                  {u.uid !== currentUser.uid && (
                    <button onClick={() => handleBanUser(u)} className="flex items-center gap-1 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/30 text-red-400 rounded-lg text-xs font-bold transition-colors uppercase tracking-wider">
                      <AlertTriangle size={14} /> Ban User
                    </button>
                  )}
                  {u.uid === currentUser.uid && <span className="text-xs text-violet-400 font-bold uppercase tracking-wider px-3">Admin</span>}
                </div>
              ))}
              {allNetworkUsers.length === 0 && <p className="text-center text-neutral-500">Loading network targets...</p>}
            </div>

            <div className="flex justify-end">
              <button onClick={() => setShowAdmin(false)} className="px-6 py-3 bg-neutral-800 text-white hover:bg-neutral-700 rounded-xl font-bold transition-colors tracking-wide">EXIT CONSOLE</button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 rounded-3xl p-8 w-full max-w-sm shadow-2xl border border-white/10">
            <h2 className="text-2xl font-bold mb-6 text-white">Profile</h2>
            <div className="mb-8 flex flex-col items-center">
              <div className="relative group cursor-pointer" onClick={() => avatarInputRef.current?.click()}>
                 <Avatar user={currentUser} size="lg" />
                 <div className="absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <ImageIcon className="text-white" size={24} />
                 </div>
              </div>
              <input type="file" ref={avatarInputRef} onChange={handleAvatarUpload} className="hidden" accept="image/*" />
              <p className="mt-4 font-semibold text-lg">{currentUser.username}</p>
            </div>
            <form onSubmit={async(e) => { e.preventDefault(); await updatePassword(auth.currentUser, newPassword); alert("Updated!"); setNewPassword(''); }}>
              <div className="mb-6">
                <input type="password" placeholder="New Password" required className="w-full px-4 py-3 bg-neutral-950 border border-white/10 text-white rounded-xl focus:outline-none focus:border-violet-500" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowSettings(false)} className="flex-1 py-3 bg-neutral-800 text-white hover:bg-neutral-700 rounded-xl font-medium transition-colors">Close</button>
                <button type="submit" disabled={!newPassword} className="flex-1 py-3 bg-violet-600 text-white font-bold rounded-xl hover:bg-violet-500 disabled:opacity-50 transition-colors">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <div className="w-1/3 max-w-sm bg-neutral-900/50 border-r border-white/5 flex flex-col relative z-10 backdrop-blur-xl">
        <div className="p-5 flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => setShowSettings(true)}>
            <Avatar user={currentUser} size="sm" />
            <span className="font-bold text-white text-lg tracking-tight">Nexus</span>
          </div>
          <div className="flex items-center gap-2">
            {currentUser.username === 'kartikane' && (
               <button onClick={() => setShowAdmin(true)} className="p-2.5 text-red-400 hover:text-white hover:bg-red-500/20 rounded-full transition-colors" title="Admin Console">
                 <Shield size={18} />
               </button>
            )}
            <button onClick={() => setShowSettings(true)} className="p-2.5 text-neutral-400 hover:text-white hover:bg-white/5 rounded-full transition-colors" title="Settings"><Settings size={18} /></button>
            <button onClick={() => signOut(auth)} className="p-2.5 text-neutral-400 hover:text-white hover:bg-white/5 rounded-full transition-colors" title="Log out"><LogOut size={18} /></button>
          </div>
        </div>

        <div className="px-4 pb-4">
          <div className="relative">
            <input type="text" placeholder="Find users..." className="w-full bg-neutral-950/50 border border-white/5 text-white rounded-2xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500/50 placeholder-neutral-500 transition-all" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            <Search className="absolute left-4 top-3.5 text-neutral-500" size={16} />
            <button onClick={handleSearchUser} className="hidden">Search</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {users.map(user => (
            <div key={user.uid} onClick={() => setActiveChat(user)} className={`p-3 flex items-center gap-4 cursor-pointer rounded-2xl transition-all ${activeChat?.uid === user.uid ? 'bg-violet-600/10 border border-violet-500/20' : 'hover:bg-white/5 border border-transparent'}`}>
              <Avatar user={user} size="md" />
              <div className="flex-1 overflow-hidden">
                 <h3 className="font-bold text-neutral-100 truncate">{user.username}</h3>
                 <p className="text-xs text-neutral-400 truncate">Tap to chat</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Chat */}
      <div className="flex-1 flex flex-col bg-neutral-950 relative">
        {activeChat ? (
          <>
            <div className="p-4 bg-neutral-900/80 backdrop-blur-md border-b border-white/5 flex items-center justify-between z-10 h-[76px]">
              <div className="flex items-center gap-4">
                <Avatar user={activeChat} size="sm" />
                <div>
                   <h2 className={`font-bold text-lg leading-tight ${activeChat.banned ? 'text-red-400 line-through' : 'text-white'}`}>
                      {activeChat.username}
                   </h2>
                   <div className="h-4">
                     {activeChat.banned ? (
                        <p className="text-xs text-red-500 font-bold uppercase">Account Terminated</p>
                     ) : partnerStatus.typing ? (
                        <p className="text-xs text-violet-400 font-semibold animate-pulse">Typing...</p>
                     ) : partnerStatus.online ? (
                        <p className="text-xs text-cyan-400 font-semibold">Online</p>
                     ) : null}
                   </div>
                </div>
              </div>
              
              <div className="flex items-center gap-3">
                <div className="relative hidden md:block">
                  <Search className="absolute left-3 top-2.5 text-neutral-500" size={14} />
                  <input type="text" placeholder="Search..." className="pl-9 pr-4 py-2 bg-neutral-950/50 border border-white/5 text-white rounded-full text-sm outline-none placeholder-neutral-500 w-48 focus:ring-1 focus:ring-violet-500/50 transition-all" value={chatSearchQuery} onChange={e => setChatSearchQuery(e.target.value)} />
                </div>
                <button onClick={() => {if(window.confirm('Clear chat?')) { const b=writeBatch(db); messages.forEach(m=>{if(!m.id.endsWith('_temp')) b.update(doc(db,"messages",m.id),{deletedBy:arrayUnion(currentUser.uid)})}); b.commit(); setMessages([]); }}} className="p-2.5 text-neutral-400 hover:text-red-400 hover:bg-red-500/10 rounded-full transition-colors">
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {filteredMessages.map((msg, idx) => {
                const isMine = msg.senderId === currentUser.uid;
                const timeStr = msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                let isAttachment = false; let attachmentInfo = null;
                if (msg.text && msg.text.startsWith('[ATTACHMENT]:')) {
                  isAttachment = true; try { attachmentInfo = JSON.parse(msg.text.substring(13)); } catch (e) {}
                }

                return (
                  <div key={msg.id || idx} className={`flex group ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-3xl px-4 py-2.5 shadow-lg relative ${isMine ? 'bg-gradient-to-br from-violet-600 to-indigo-600 text-white rounded-tr-sm' : 'bg-neutral-800 text-neutral-100 rounded-tl-sm border border-white/5'}`}>
                      {isAttachment && attachmentInfo ? (
                        <div className="mt-1 mb-2"><AttachmentViewer attachmentInfo={attachmentInfo} /></div>
                      ) : (
                        <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">{msg.text}</p>
                      )}
                      
                      <div className="flex items-center justify-end gap-1.5 mt-1 opacity-80">
                        <span className="text-[10px] text-white/70 whitespace-nowrap">{timeStr}</span>
                        {isMine && msg.read && <span className="text-[11px] text-cyan-300 font-black tracking-tighter">✓✓</span>}
                        {isMine && !msg.read && !msg.id.endsWith('_temp') && <span className="text-[11px] text-white/40 font-bold tracking-tighter">✓✓</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} className="h-4" />
            </div>

            <div className="p-4 bg-transparent absolute bottom-0 w-full bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-transparent pt-10">
              <div className="flex gap-2 items-center max-w-4xl mx-auto bg-neutral-900/90 backdrop-blur-xl border border-white/10 p-2 rounded-full shadow-2xl">
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*,audio/*" />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile || isRecording || activeChat.banned} className="p-2.5 text-neutral-400 hover:text-white hover:bg-white/10 rounded-full transition-colors disabled:opacity-50">
                  {uploadingFile ? <Loader2 className="animate-spin" size={22} /> : <Paperclip size={22} />}
                </button>

                <input type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} disabled={activeChat.banned} placeholder={activeChat.banned ? "Cannot message a banned user." : "Message..."} className="flex-1 bg-transparent text-white placeholder-neutral-500 focus:outline-none px-2 disabled:opacity-50" />
                
                {newMessage.trim() ? (
                  <button onClick={handleSendMessage} disabled={activeChat.banned} className="bg-violet-600 text-white rounded-full p-2.5 hover:bg-violet-500 transition-colors shadow-lg shadow-violet-500/20 disabled:opacity-50">
                    <Send size={20} className="ml-0.5" />
                  </button>
                ) : (
                  <button onMouseDown={startRecording} onMouseUp={stopRecording} onMouseLeave={stopRecording} disabled={activeChat.banned} className={`${isRecording ? 'bg-red-500 animate-pulse' : 'bg-neutral-800 hover:bg-neutral-700'} text-white rounded-full p-2.5 transition-colors disabled:opacity-50`}>
                    {isRecording ? <Square size={20} /> : <Mic size={20} />}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 relative z-10">
            <div className="w-24 h-24 rounded-full bg-violet-600/10 flex items-center justify-center mb-6 border border-violet-500/20 shadow-[0_0_50px_rgba(139,92,246,0.1)]">
               <Zap size={40} className="text-violet-500" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-3 tracking-tight">Nexus Chat</h2>
            <p className="text-neutral-500">Select a contact or search a username to begin.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

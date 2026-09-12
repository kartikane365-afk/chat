import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, Send, User, Lock, Loader2, LogOut, Search, Trash2, Paperclip, Settings, File, Image as ImageIcon, Video, Mic, Square } from 'lucide-react';
import { generateKeyPair, encryptMessage, decryptMessage, encryptFile, decryptFile } from './crypto';
import { auth, db } from './firebase';
import { 
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword
} from 'firebase/auth';
import { 
  collection, doc, setDoc, getDoc, getDocs, query, where, orderBy, onSnapshot,
  addDoc, serverTimestamp, updateDoc, arrayUnion, writeBatch
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
      const MAX_DIM = 800; // Shrink max width/height to save DB space
      let { width, height } = img;
      if (width > height) {
        if (width > MAX_DIM) { height *= MAX_DIM / width; width = MAX_DIM; }
      } else {
        if (height > MAX_DIM) { width *= MAX_DIM / height; height = MAX_DIM; }
      }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.6); // 60% quality
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
      // 1. Rebuild encrypted blob from Base64 string directly from Firestore!
      const byteCharacters = atob(attachmentInfo.data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const encryptedBlob = new Blob([byteArray]);

      // 2. Decrypt with AES
      const decryptedBlob = await decryptFile(encryptedBlob, attachmentInfo.key, attachmentInfo.mime);
      setBlobUrl(URL.createObjectURL(decryptedBlob));
    } catch(err) {
      console.error(err);
      alert("Failed to decrypt file.");
    }
    setLoading(false);
  };

  if (blobUrl) {
    if (attachmentInfo.mime.startsWith('image/')) return <img src={blobUrl} alt={attachmentInfo.name} className="max-w-full h-auto rounded-lg max-h-[300px]" />;
    if (attachmentInfo.mime.startsWith('video/')) return <video src={blobUrl} controls className="max-w-full rounded-lg max-h-[300px]" />;
    if (attachmentInfo.mime.startsWith('audio/')) return <audio src={blobUrl} controls className="w-full max-w-[250px]" />;
    return <a href={blobUrl} download={attachmentInfo.name} className="text-green-400 hover:text-green-300 underline font-semibold flex items-center gap-1"><File size={16}/> Download {attachmentInfo.name}</a>;
  }

  const FileIcon = attachmentInfo.mime.startsWith('image/') ? ImageIcon : (attachmentInfo.mime.startsWith('video/') ? Video : (attachmentInfo.mime.startsWith('audio/') ? Mic : File));

  return (
    <button onClick={loadFile} disabled={loading} className="bg-gray-800 hover:bg-gray-700 border border-gray-600 px-4 py-3 rounded-lg text-sm flex items-center gap-3 w-full max-w-sm text-left transition-colors">
      <div className="bg-[#005c4b] text-white p-2 rounded-full">
        {loading ? <Loader2 className="animate-spin" size={20}/> : <FileIcon size={20} />}
      </div>
      <div className="flex-1 overflow-hidden">
        <p className="font-semibold text-gray-200 truncate">{attachmentInfo.name === 'voice_message.webm' ? 'Voice Message' : attachmentInfo.name}</p>
        <p className="text-xs text-gray-400">Encrypted DB File • Click to View</p>
      </div>
    </button>
  );
};

// --- Avatar Component ---
const Avatar = ({ user, size = "md" }) => {
  const dimensions = size === "lg" ? "w-24 h-24 text-4xl" : (size === "sm" ? "w-10 h-10 text-lg" : "w-12 h-12 text-xl");
  if (user?.avatar) {
    return <img src={user.avatar} alt="avatar" className={`${dimensions} rounded-full object-cover`} />;
  }
  return (
    <div className={`${dimensions} rounded-full bg-[#00a884] flex items-center justify-center text-gray-900 font-bold`}>
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
  const [authError, setAuthError] = useState('');
  
  const [initialLoad, setInitialLoad] = useState(true);
  const [uploadingFile, setUploadingFile] = useState(false);
  
  const [showSettings, setShowSettings] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const avatarInputRef = useRef(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const username = user.email.split('@')[0];
        const privKey = JSON.parse(localStorage.getItem(`privkey_${username}`));
        
        let profile = { username };
        try {
          const userDoc = await getDoc(doc(db, "users", user.uid));
          if (userDoc.exists()) profile = userDoc.data();
        } catch (e) {
          console.error("Failed to load user profile");
        }

        setCurrentUser({ uid: user.uid, ...profile });
        setSessionKeys(privKey ? { privateKeyJwk: privKey } : null);

        const savedContacts = JSON.parse(localStorage.getItem(`contacts_${username}`)) || [];
        setUsers(savedContacts);
      } else {
        setCurrentUser(null);
        setSessionKeys(null);
        setUsers([]);
        setActiveChat(null);
      }
      setInitialLoad(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!currentUser || !activeChat || !sessionKeys) return;
    
    setMessages([]);
    setChatSearchQuery('');
    const chatId = getChatId(currentUser.uid, activeChat.uid);
    
    const q = query(collection(db, "messages"), where("chatId", "==", chatId), orderBy("timestamp", "asc"));

    const unsubscribe = onSnapshot(q, async (snapshot) => {
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
            
            // Read Receipts: Mark as read if we received it and haven't read it yet
            if (!data.read) {
               updateDoc(doc(db, "messages", document.id), { read: true }).catch(console.error);
            }
          }
        } catch (err) {
          text = "[Decryption Failed]";
        }

        msgs.push({ id: document.id, ...data, text });
      }
      setMessages(msgs);
    });

    return () => unsubscribe();
  }, [activeChat, currentUser, sessionKeys]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatSearchQuery]);

  // Typing Indicator Logic
  useEffect(() => {
    if (!currentUser) return;
    const typingStatus = newMessage.length > 0 && activeChat ? activeChat.uid : null;
    updateDoc(doc(db, "users", currentUser.uid), { typingTo: typingStatus }).catch(()=>null);
    
    // Clear typing indicator when closing tab
    const handleBeforeUnload = () => updateDoc(doc(db, "users", currentUser.uid), { typingTo: null }).catch(()=>null);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [newMessage, activeChat, currentUser]);

  // Listen to active chat's typing status
  const [partnerTyping, setPartnerTyping] = useState(false);
  useEffect(() => {
    if (!activeChat || !currentUser) return;
    const unsubscribe = onSnapshot(doc(db, "users", activeChat.uid), (docSnap) => {
       if (docSnap.exists()) {
          setPartnerTyping(docSnap.data().typingTo === currentUser.uid);
          // Also update avatar if they changed it
          if (docSnap.data().avatar !== activeChat.avatar) {
             setActiveChat(prev => ({...prev, avatar: docSnap.data().avatar}));
          }
       }
    });
    return () => unsubscribe();
  }, [activeChat, currentUser]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    const fakeEmail = `${authUsername.toLowerCase()}@whatsappclone.local`;

    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, fakeEmail, authPassword);
      } else {
        const { publicKeyJwk, privateKeyJwk } = await generateKeyPair();
        localStorage.setItem(`privkey_${authUsername.toLowerCase()}`, JSON.stringify(privateKeyJwk));
        const userCredential = await createUserWithEmailAndPassword(auth, fakeEmail, authPassword);
        await setDoc(doc(db, "users", userCredential.user.uid), {
          username: authUsername, public_key: publicKeyJwk, avatar: null, typingTo: null
        });
      }
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') setAuthError('Username already taken.');
      else if (err.code === 'auth/invalid-credential') setAuthError('Invalid credentials.');
      else setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!newPassword) return;
    try {
      await updatePassword(auth.currentUser, newPassword);
      alert("Password updated successfully!");
      setNewPassword('');
    } catch (err) {
      alert("Failed to update password. You may need to log out and log back in first.");
    }
  };

  const handleAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 150;
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
          alert("Profile picture updated!");
        } catch (err) {
          alert("Failed to update profile picture.");
        }
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSearchUser = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim() || !currentUser) return;
    if (searchQuery.toLowerCase() === currentUser.username.toLowerCase()) {
      alert("You cannot chat with yourself!"); setSearchQuery(''); return;
    }
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
    } catch (err) { alert("Failed to search."); } 
    finally { setIsSearching(false); }
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
    } catch (err) {
      alert("Failed to send securely.");
    }
  };

  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    if (!newMessage.trim() || !activeChat || !currentUser) return;
    const textToSend = newMessage;
    setNewMessage('');
    setMessages(prev => [...prev, { id: Date.now().toString() + "_temp", senderId: currentUser.uid, text: textToSend, timestamp: new Date() }]);
    await sendPayloadToFirestore(textToSend);
  };

  // Generic attachment uploader that bypasses Firebase Storage by saving to DB limit
  const uploadAttachment = async (rawFile, fileName, mimeType) => {
    setUploadingFile(true);
    try {
      let finalBlob = rawFile;

      // Compress if it's an image
      if (mimeType.startsWith('image/')) {
         finalBlob = await compressImage(rawFile);
         fileName = fileName.replace(/\.[^/.]+$/, "") + ".jpg"; // Ensure extension matches
         mimeType = 'image/jpeg';
      }

      // Check strict 1MB Firestore limit (~700KB before base64/encryption overhead)
      if (finalBlob.size > 700 * 1024) {
         alert("File is too large for the database workaround! Please select a smaller image or record a shorter voice note.");
         setUploadingFile(false);
         return;
      }

      // 1. Encrypt raw file with AES
      const { encryptedBlob, keyBase64 } = await encryptFile(finalBlob);
      
      // 2. Convert encrypted blob to Base64 String
      const encryptedBase64 = await fileToBase64(encryptedBlob);

      // 3. Construct JSON Payload directly (no URLs)
      const attachmentData = { type: "FILE", data: encryptedBase64, key: keyBase64, name: fileName, mime: mimeType };
      const textToSend = `[ATTACHMENT]:${JSON.stringify(attachmentData)}`;

      setMessages(prev => [...prev, { id: Date.now().toString() + "_temp", senderId: currentUser.uid, text: textToSend, timestamp: new Date() }]);
      await sendPayloadToFirestore(textToSend);
    } catch (err) {
      alert("Failed to send attachment: " + err.message);
    } finally {
      setUploadingFile(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file || !activeChat || !currentUser) return;
    uploadAttachment(file, file.name, file.type);
    if (fileInputRef.current) fileInputRef.current.value = null;
  };

  // Voice Note Logic
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = e => { if(e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) { alert("Microphone access denied or unavailable."); }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        uploadAttachment(audioBlob, "voice_message.webm", "audio/webm");
      };
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

  if (initialLoad) return <div className="min-h-screen bg-[#111b21] flex items-center justify-center"><Loader2 className="animate-spin text-green-500" size={32} /></div>;

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-[#111b21] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#202c33] rounded-xl shadow-2xl p-8 border border-gray-700">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[#005c4b] text-white mb-4"><Lock size={32} /></div>
            <h1 className="text-2xl font-bold text-gray-100">Secure E2EE Chat</h1>
          </div>
          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <input type="text" required placeholder="Username" className="w-full px-4 py-3 border border-gray-600 bg-[#2a3942] text-white rounded-lg focus:outline-none focus:border-green-500" value={authUsername} onChange={e => setAuthUsername(e.target.value)} />
            </div>
            <div>
              <input type="password" required placeholder="Password" className="w-full px-4 py-3 border border-gray-600 bg-[#2a3942] text-white rounded-lg focus:outline-none focus:border-green-500" value={authPassword} onChange={e => setAuthPassword(e.target.value)} />
            </div>
            {authError && <div className="p-3 rounded-lg text-sm bg-red-900 bg-opacity-50 text-red-200 border border-red-800">{authError}</div>}
            <button type="submit" disabled={authLoading} className="w-full bg-[#00a884] text-gray-900 py-3 rounded-lg font-bold hover:bg-[#00c298] flex items-center justify-center transition-colors">
              {authLoading ? <Loader2 className="animate-spin" size={20} /> : (isLogin ? 'Log In' : 'Create Account')}
            </button>
          </form>
          <div className="mt-6 text-center text-sm text-gray-400">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button onClick={() => setIsLogin(!isLogin)} className="text-[#00a884] font-semibold hover:underline">{isLogin ? 'Register' : 'Log in'}</button>
          </div>
        </div>
      </div>
    );
  }

  if (currentUser && !sessionKeys) {
    return (
      <div className="min-h-screen bg-[#111b21] flex items-center justify-center p-4 text-center">
        <div className="max-w-md w-full bg-[#202c33] border border-gray-700 rounded-xl shadow-2xl p-8">
          <Lock size={48} className="mx-auto text-red-500 mb-4" />
          <h2 className="text-xl font-bold mb-2 text-gray-100">Encryption Key Missing</h2>
          <p className="text-gray-400 mb-6">Your private key is not found on this device. Log out and create a new account to fix this!</p>
          <button onClick={() => signOut(auth)} className="bg-gray-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-gray-600">Log Out</button>
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
    <div className="flex h-screen bg-[#111b21] font-sans text-gray-100">
      
      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center p-4">
          <div className="bg-[#202c33] rounded-xl p-8 w-full max-w-sm shadow-xl border border-gray-700">
            <h2 className="text-xl font-bold mb-6 text-white">Account Settings</h2>
            
            <div className="mb-6 flex flex-col items-center">
              <Avatar user={currentUser} size="lg" />
              <input type="file" ref={avatarInputRef} onChange={handleAvatarUpload} className="hidden" accept="image/*" />
              <button onClick={() => avatarInputRef.current?.click()} className="mt-3 text-sm text-[#00a884] hover:underline font-semibold">Change Profile Picture</button>
            </div>

            <form onSubmit={handleChangePassword}>
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-300 mb-1">New Password</label>
                <input type="password" required className="w-full px-3 py-2 bg-[#2a3942] border border-gray-600 text-white rounded-lg focus:outline-none focus:border-[#00a884]" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowSettings(false)} className="px-4 py-2 bg-gray-700 text-gray-200 hover:bg-gray-600 rounded-lg">Done</button>
                <button type="submit" disabled={!newPassword} className="px-4 py-2 bg-[#00a884] text-gray-900 font-bold rounded-lg hover:bg-[#00c298] disabled:opacity-50">Save Password</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <div className="w-1/3 max-w-sm bg-[#111b21] border-r border-gray-800 flex flex-col">
        <div className="p-4 bg-[#202c33] flex justify-between items-center h-16">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setShowSettings(true)}>
            <Avatar user={currentUser} size="sm" />
            <span className="font-semibold text-gray-200">{currentUser.username}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:bg-gray-700 rounded-full transition-colors"><Settings size={20} /></button>
            <button onClick={() => signOut(auth)} className="p-2 text-gray-400 hover:bg-gray-700 rounded-full transition-colors"><LogOut size={20} /></button>
          </div>
        </div>

        <div className="p-2 bg-[#111b21] border-b border-gray-800">
          <form onSubmit={handleSearchUser} className="relative">
            <input type="text" placeholder="Search exact username..." className="w-full bg-[#202c33] text-gray-200 rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none placeholder-gray-400" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
            <button type="submit" className="hidden">Search</button>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto">
          {users.map(user => (
            <div key={user.uid} onClick={() => setActiveChat(user)} className={`p-3 flex items-center gap-4 cursor-pointer hover:bg-[#202c33] border-b border-gray-800 transition-colors ${activeChat?.uid === user.uid ? 'bg-[#2a3942]' : ''}`}>
              <Avatar user={user} size="md" />
              <div className="flex-1">
                 <h3 className="font-semibold text-gray-200">{user.username}</h3>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Chat */}
      <div className="flex-1 flex flex-col bg-[#0b141a]">
        {activeChat ? (
          <>
            <div className="p-4 bg-[#202c33] flex items-center justify-between shadow-sm h-16">
              <div className="flex items-center gap-4">
                <Avatar user={activeChat} size="sm" />
                <div>
                   <h2 className="font-semibold text-gray-200">{activeChat.username}</h2>
                   {partnerTyping && <p className="text-xs text-[#00a884] font-medium animate-pulse">typing...</p>}
                </div>
              </div>
              
              <div className="flex items-center gap-4">
                <div className="relative hidden md:block">
                  <Search className="absolute left-3 top-2 text-gray-400" size={14} />
                  <input type="text" placeholder="Search messages..." className="pl-9 pr-3 py-1.5 bg-[#2a3942] text-gray-200 rounded-full text-sm outline-none placeholder-gray-400 w-48 focus:bg-[#324550]" value={chatSearchQuery} onChange={e => setChatSearchQuery(e.target.value)} />
                </div>
                <button onClick={handleDeleteEntireChat} className="text-red-400 hover:text-red-300 text-sm font-semibold flex items-center gap-1 px-3 py-1.5 bg-red-900 bg-opacity-30 hover:bg-opacity-50 rounded-lg transition-colors">
                  <Trash2 size={16} /> Clear
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {filteredMessages.map((msg, idx) => {
                const isMine = msg.senderId === currentUser.uid;
                const timeStr = msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '...';

                let isAttachment = false;
                let attachmentInfo = null;
                if (msg.text && msg.text.startsWith('[ATTACHMENT]:')) {
                  isAttachment = true;
                  try { attachmentInfo = JSON.parse(msg.text.substring(13)); } catch (e) {}
                }

                return (
                  <div key={msg.id || idx} className={`flex group ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-lg px-3 py-2 shadow-sm relative ${isMine ? 'bg-[#005c4b] text-[#e9edef] rounded-tr-none' : 'bg-[#202c33] text-[#e9edef] rounded-tl-none'}`}>
                      
                      {isAttachment && attachmentInfo ? (
                        <div className="mt-1 mb-2">
                           <AttachmentViewer attachmentInfo={attachmentInfo} />
                        </div>
                      ) : (
                        <p className="text-[15px] leading-relaxed pr-8 break-words whitespace-pre-wrap">{msg.text}</p>
                      )}
                      
                      <div className="flex items-center justify-end gap-1.5 mt-0.5">
                        <span className="text-[10px] text-gray-400 whitespace-nowrap">{timeStr}</span>
                        {isMine && msg.read && <span className="text-[10px] text-blue-400 font-bold">✓✓</span>}
                        {isMine && !msg.read && !msg.id.endsWith('_temp') && <span className="text-[10px] text-gray-400 font-bold">✓✓</span>}
                        {!msg.id.endsWith('_temp') && (
                          <button onClick={() => handleDeleteMessage(msg.id)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400 transition-opacity ml-1">
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-3 bg-[#202c33] flex gap-2 items-center">
              <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*,audio/*" />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile || isRecording} className="p-3 text-gray-400 hover:text-gray-200 hover:bg-[#2a3942] rounded-full transition-colors">
                {uploadingFile ? <Loader2 className="animate-spin" size={24} /> : <Paperclip size={24} />}
              </button>

              <form onSubmit={handleSendMessage} className="flex-1 flex gap-2 items-center">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message"
                  className="flex-1 rounded-lg px-4 py-3 bg-[#2a3942] text-gray-200 placeholder-gray-400 focus:outline-none border border-transparent focus:border-[#00a884]"
                />
                {newMessage.trim() ? (
                  <button type="submit" className="bg-[#00a884] text-gray-900 rounded-full p-3 hover:bg-[#00c298] transition-colors">
                    <Send size={20} />
                  </button>
                ) : (
                  <button 
                    type="button" 
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={stopRecording}
                    className={`${isRecording ? 'bg-red-500 text-white animate-pulse' : 'bg-[#00a884] text-gray-900 hover:bg-[#00c298]'} rounded-full p-3 transition-colors`}
                  >
                    {isRecording ? <Square size={20} /> : <Mic size={20} />}
                  </button>
                )}
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
            <div className="w-24 h-24 rounded-full bg-[#202c33] flex items-center justify-center mb-6"><MessageSquare size={48} className="text-gray-400" /></div>
            <h2 className="text-2xl font-light text-gray-300 mb-2">WhatsApp Web Secure</h2>
            <p className="text-sm text-gray-500">Select a contact to start messaging securely.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

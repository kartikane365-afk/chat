import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, Send, User, Lock, Loader2, LogOut, Search } from 'lucide-react';
import { generateKeyPair, encryptMessage, decryptMessage } from './crypto';
import { auth, db } from './firebase';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  addDoc,
  serverTimestamp
} from 'firebase/firestore';

// Helper to generate consistent chat IDs between two users
const getChatId = (uid1, uid2) => [uid1, uid2].sort().join('_');

function App() {
  const [currentUser, setCurrentUser] = useState(null); // Firebase auth user
  const [sessionKeys, setSessionKeys] = useState(null); // { privateKeyJwk }
  const [users, setUsers] = useState([]); // Now represents "Contacts" or "Active Chats"
  const [activeChat, setActiveChat] = useState(null); 
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  
  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // Auth State
  const [isLogin, setIsLogin] = useState(true);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  
  const [initialLoad, setInitialLoad] = useState(true);
  const messagesEndRef = useRef(null);

  // Monitor Authentication State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        const username = user.email.split('@')[0];
        const privKey = JSON.parse(localStorage.getItem(`privkey_${username}`));
        
        setCurrentUser({ uid: user.uid, username });
        setSessionKeys(privKey ? { privateKeyJwk: privKey } : null);

        // Load saved contacts from Local Storage
        const savedContacts = JSON.parse(localStorage.getItem(`contacts_${username}`)) || [];
        setUsers(savedContacts);
      } else {
        setCurrentUser(null);
        setSessionKeys(null);
        setUsers([]);
      }
      setInitialLoad(false);
    });
    return () => unsubscribe();
  }, []);

  // Listen to messages for active chat in real-time
  useEffect(() => {
    if (!currentUser || !activeChat || !sessionKeys) return;
    
    setMessages([]);
    const chatId = getChatId(currentUser.uid, activeChat.uid);
    
    const q = query(
      collection(db, "messages"),
      where("chatId", "==", chatId),
      orderBy("timestamp", "asc")
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const msgs = [];
      for (const doc of snapshot.docs) {
        const data = doc.data();
        let text = '';

        if (data.senderId === currentUser.uid) {
          text = "[Sent Message - Encrypted for receiver]";
        } else {
          text = await decryptMessage(data.encryptedContent, sessionKeys.privateKeyJwk);
        }

        msgs.push({
          id: doc.id,
          ...data,
          text
        });
      }
      // Replace optimistic messages with actual server messages
      setMessages(msgs);
    });

    return () => unsubscribe();
  }, [activeChat, currentUser, sessionKeys]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
        
        // BUGFIX: Save private key locally BEFORE creating the user
        localStorage.setItem(`privkey_${authUsername.toLowerCase()}`, JSON.stringify(privateKeyJwk));

        const userCredential = await createUserWithEmailAndPassword(auth, fakeEmail, authPassword);
        const user = userCredential.user;

        await setDoc(doc(db, "users", user.uid), {
          username: authUsername,
          public_key: publicKeyJwk
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

  const handleSearchUser = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim() || !currentUser) return;
    
    if (searchQuery.toLowerCase() === currentUser.username.toLowerCase()) {
      alert("You cannot chat with yourself!");
      setSearchQuery('');
      return;
    }

    setIsSearching(true);
    try {
      // Find user by exact username
      const q = query(collection(db, "users"), where("username", "==", searchQuery.trim()));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        alert("No user found with that exact username!");
      } else {
        const foundUser = { uid: querySnapshot.docs[0].id, ...querySnapshot.docs[0].data() };
        
        // Add to sidebar if not already there
        if (!users.find(u => u.uid === foundUser.uid)) {
          const updatedUsers = [foundUser, ...users];
          setUsers(updatedUsers);
          localStorage.setItem(`contacts_${currentUser.username}`, JSON.stringify(updatedUsers));
        }
        
        setActiveChat(foundUser);
        setSearchQuery('');
      }
    } catch (err) {
      console.error("Search error", err);
      alert("Failed to search. Check your database rules.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !activeChat || !currentUser) return;

    const textToSend = newMessage;
    setNewMessage('');

    // Optimistically add to UI for INSTANT feedback (no network delay on your end)
    const fakeMsg = {
      id: Date.now().toString() + "_temp",
      senderId: currentUser.uid,
      text: textToSend,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, fakeMsg]);

    try {
      const encryptedContent = await encryptMessage(textToSend, activeChat.public_key);
      const chatId = getChatId(currentUser.uid, activeChat.uid);

      await addDoc(collection(db, "messages"), {
        chatId,
        senderId: currentUser.uid,
        receiverId: activeChat.uid,
        encryptedContent,
        timestamp: serverTimestamp()
      });
    } catch (err) {
      console.error("Failed to send", err);
    }
  };

  const handleLogout = () => {
    signOut(auth);
    setActiveChat(null);
  };

  if (initialLoad) return <div className="min-h-screen bg-gray-100 flex items-center justify-center"><Loader2 className="animate-spin text-green-600" size={32} /></div>;

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 text-green-600 mb-4">
              <Lock size={32} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Secure E2EE Chat</h1>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
              <input type="text" required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500" value={authUsername} onChange={e => setAuthUsername(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input type="password" required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500" value={authPassword} onChange={e => setAuthPassword(e.target.value)} />
            </div>
            {authError && <div className="p-3 rounded-lg text-sm bg-red-50 text-red-700">{authError}</div>}
            <button type="submit" disabled={authLoading} className="w-full bg-green-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-green-700 flex items-center justify-center">
              {authLoading ? <Loader2 className="animate-spin" size={20} /> : (isLogin ? 'Log In' : 'Create Account')}
            </button>
          </form>
          <div className="mt-6 text-center text-sm text-gray-600">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button onClick={() => setIsLogin(!isLogin)} className="text-green-600 font-semibold hover:underline">
              {isLogin ? 'Register' : 'Log in'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (currentUser && !sessionKeys) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4 text-center">
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8">
          <Lock size={48} className="mx-auto text-red-500 mb-4" />
          <h2 className="text-xl font-bold mb-2">Encryption Key Missing</h2>
          <p className="text-gray-600 mb-6">Your private key is not found on this device. Log out and create a new account to fix this!</p>
          <button onClick={handleLogout} className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg font-medium hover:bg-gray-300">Log Out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100 font-sans">
      {/* Sidebar */}
      <div className="w-1/3 max-w-sm bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
              {currentUser.username[0].toUpperCase()}
            </div>
            <span className="font-semibold text-gray-800">{currentUser.username}</span>
          </div>
          <button onClick={handleLogout} className="p-2 text-gray-500 hover:bg-gray-200 rounded-full">
            <LogOut size={20} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-3 bg-white border-b border-gray-100">
          <form onSubmit={handleSearchUser} className="relative">
            <input
              type="text"
              placeholder="Search by exact username..."
              className="w-full bg-gray-100 rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
            <button type="submit" className="hidden">Search</button>
          </form>
          {isSearching && <div className="text-xs text-green-600 mt-2">Searching database...</div>}
        </div>

        {/* Contacts List */}
        <div className="flex-1 overflow-y-auto">
          {users.map(user => (
            <div
              key={user.uid}
              onClick={() => setActiveChat(user)}
              className={`p-4 flex items-center gap-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100 ${activeChat?.uid === user.uid ? 'bg-green-50' : ''}`}
            >
              <div className="w-12 h-12 rounded-full bg-gray-300 flex items-center justify-center text-gray-600">
                <User size={24} />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{user.username}</h3>
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <div className="p-8 text-center text-gray-500 text-sm">
              Your contact list is empty. Type a friend's exact username in the search box above and press Enter to start chatting!
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-[#efeae2]">
        {activeChat ? (
          <>
            <div className="p-4 bg-white border-b border-gray-200 flex items-center gap-3 shadow-sm">
              <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-gray-600">
                <User size={20} />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">{activeChat.username}</h2>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((msg, idx) => {
                const isMine = msg.senderId === currentUser.uid;
                const timeStr = msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Sending...';

                return (
                  <div key={msg.id || idx} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-lg px-4 py-2 shadow-sm ${isMine ? 'bg-[#d9fdd3] text-gray-900 rounded-tr-none' : 'bg-white text-gray-900 rounded-tl-none'}`}>
                      <p className="text-[15px] leading-relaxed">{msg.text}</p>
                      <span className="text-[11px] text-gray-500 mt-1 block text-right">{timeStr}</span>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 bg-gray-50 border-t border-gray-200">
              <form onSubmit={handleSendMessage} className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message"
                  className="flex-1 rounded-lg px-4 py-3 bg-white border border-gray-300 focus:outline-none focus:border-green-500"
                />
                <button type="submit" disabled={!newMessage.trim()} className="bg-green-600 text-white rounded-lg px-4 py-3 hover:bg-green-700 disabled:opacity-50 transition-colors">
                  <Send size={20} />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
            <div className="w-24 h-24 rounded-full bg-gray-200 flex items-center justify-center mb-4">
              <MessageSquare size={48} className="text-gray-400" />
            </div>
            <h2 className="text-2xl font-light text-gray-600 mb-2">WhatsApp Web Clone</h2>
            <p className="text-sm">Search for a user on the left to start a secure chat.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

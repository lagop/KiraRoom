import React, { useState, useEffect, useRef } from 'react';
import { Send, X, Minimize, Maximize, MessageCircle, Phone } from 'lucide-react';
import apiClient from '@/lib/api';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  provider?: string;
  error?: string;
}

interface MessageResponseDto {
  id: string;
  content: string;
  requiresHandoff: boolean;
  provider?: string;
  error?: string;
}

interface ChatWidgetProps {
  salonId?: string;
  clientId?: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  className?: string;
  isOpenByDefault?: boolean;
}

const ChatWidget: React.FC<ChatWidgetProps> = ({ 
  salonId = 'default', 
  clientId = 'anonymous',
  clientName,
  clientEmail,
  clientPhone,
  className = '',
  isOpenByDefault = false
}) => {
  const [isOpen, setIsOpen] = useState(isOpenByDefault);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      const response: MessageResponseDto = await apiClient.sendVirtualReceptionistMessage({
        clientId,
        salonId,
        message: inputValue,
        channel: 'web',
        metadata: {
          clientName,
          clientEmail,
          clientPhone,
        },
      });

      const assistantMessage: ChatMessage = {
        id: response.id,
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
        provider: response.provider,
        error: response.error,
      };

      setMessages(prev => [...prev, assistantMessage]);

      if (response.requiresHandoff) {
        setShowHandoff(true);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      const apiError = error as { status?: number; message?: string };
      let detail = '';
      if (apiError?.status) {
        detail = apiError.message
          ? ` (HTTP ${apiError.status}: ${apiError.message})`
          : ` (HTTP ${apiError.status})`;
      } else if (apiError?.message) {
        detail = ` (${apiError.message})`;
      }
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Lo sentimos, estamos experimentando problemas. Por favor, inténtalo de nuevo.${detail}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  };

  const handleHandoff = () => {
    // In a real implementation, this would connect to human agent
    const handoffMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'assistant',
      content: 'Te estamos conectando con un representante. Por favor, espera un momento.',
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, handoffMessage]);
    setShowHandoff(false);
  };

  if (!isOpen) {
    return (
      <div className={`fixed bottom-6 right-6 z-50 ${className}`}>
        <button
          onClick={() => setIsOpen(true)}
          className="bg-purple-600 text-white rounded-full p-4 shadow-lg hover:bg-purple-700 transition-colors"
        >
          <MessageCircle className="w-6 h-6" />
        </button>
      </div>
    );
  }

  return (
    <div className={`fixed bottom-6 right-6 z-50 ${className}`}>
      <div className={`bg-white rounded-lg shadow-xl w-80 h-96 flex flex-col ${
        isMinimized ? 'h-14' : ''
      }`}>
        {/* Header */}
        <div className="bg-purple-600 text-white px-4 py-3 rounded-t-lg flex justify-between items-center">
          <div className="flex items-center space-x-2">
            <MessageCircle className="w-5 h-5" />
            <span className="font-semibold">Asistente Virtual</span>
          </div>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setIsMinimized(!isMinimized)}
              className="p-1 hover:bg-purple-700 rounded"
            >
              {isMinimized ? <Maximize className="w-4 h-4" /> : <Minimize className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 hover:bg-purple-700 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        {!isMinimized && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 bg-gray-50">
              {/* Welcome message */}
              {messages.length === 0 && (
                <div className="text-center text-gray-600 py-8">
                  <MessageCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="font-medium text-gray-800">¡Hola!</p>
                  <p className="text-sm">¿En qué puedo ayudarte hoy?</p>
                </div>
              )}

              {/* Messages list */}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] px-3 py-2 rounded-lg ${
                      message.role === 'user'
                        ? 'bg-purple-600 text-white rounded-br-none'
                        : 'bg-white text-gray-800 rounded-bl-none shadow-sm'
                    }`}
                  >
                    <p className="text-sm">{message.content}</p>
                    {message.error && (
                      <p
                        className="text-xs mt-1 px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200 break-words"
                        title="Debug: underlying error returned by the backend"
                      >
                        <span className="font-semibold">Debug:</span> {message.error}
                      </p>
                    )}
                    {message.provider && (
                      <p className="text-xs opacity-70 mt-1">
                        {message.provider === 'openai' ? 'OpenAI' :
                         message.provider === 'anthropic' ? 'Anthropic' :
                         message.provider === 'google' ? 'Google' : 'LLM'}
                      </p>
                    )}
                    <p className="text-xs opacity-60 mt-1">
                      {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ))}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-white text-gray-800 px-3 py-2 rounded-lg rounded-bl-none shadow-sm">
                    <div className="flex space-x-2">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-gray-200">
              {showHandoff && (
                <div className="mb-3 p-2 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm text-yellow-800">
                    ¿Necesitas hablar con un representante humano?
                  </p>
                  <button
                    onClick={handleHandoff}
                    className="mt-2 text-sm text-purple-600 hover:text-purple-700 font-medium"
                  >
                    <Phone className="w-4 h-4 inline mr-1" />
                    Conectar con agente
                  </button>
                </div>
              )}

              <div className="flex space-x-2">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Escribe tu mensaje..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={isLoading}
                />
                <button
                  onClick={handleSendMessage}
                  disabled={isLoading || !inputValue.trim()}
                  className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ChatWidget;
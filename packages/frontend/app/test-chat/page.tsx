'use client';

import { useState, useEffect } from 'react';
import { ChatWidget } from '@/src/components/virtual-receptionist';

export default function TestChatPage() {
  useEffect(() => {
    // Scroll to bottom to see the widget
    window.scrollTo(0, document.body.scrollHeight);
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <h1 className="text-3xl font-bold mb-8 text-center">Test Chat Widget</h1>
      <div className="max-w-4xl mx-auto h-[200vh]">
        <p className="mb-10">Scroll down to see the chat widget...</p>
        <ChatWidget 
          salonId="1" 
          clientId="1" 
          clientName="John Doe"
          clientEmail="john.doe@example.com"
          clientPhone="+34 123 456 789"
          isOpenByDefault={true}
        />
      </div>
    </div>
  );
}

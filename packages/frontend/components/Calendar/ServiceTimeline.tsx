"use client";

import React, { useState, useRef } from "react";
import { Clock, GripVertical, Users, ArrowRight } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

interface ServiceItem {
  id: string;
  serviceId: string;
  serviceName: string;
  professionalId?: string;
  professionalName?: string;
  scheduledStart: string;
  scheduledEnd: string;
  isParallel: boolean;
  order: number;
  duration: number;
  price: number;
}

interface ServiceTimelineProps {
  services: ServiceItem[];
  onReorder?: (services: ServiceItem[]) => void;
  onTimeChange?: (
    serviceId: string,
    scheduledStart: string,
    scheduledEnd: string,
  ) => void;
  onModeToggle?: (serviceId: string, isParallel: boolean) => void;
  editable?: boolean;
  timezone?: string;
}

export function ServiceTimeline({
  services,
  onReorder,
  onTimeChange,
  onModeToggle,
  editable = false,
  timezone,
}: ServiceTimelineProps) {
  const t = useTranslations();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const [tempStartTime, setTempStartTime] = useState<string>("");
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  // Sort services by order
  const sortedServices = [...services].sort((a, b) => a.order - b.order);

  // Format time for display
  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    // For appointment display, use local time formatting to match the appointment header
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

  // Handle drag start
  const handleDragStart = (index: number) => {
    if (!editable) return;
    dragItem.current = index;
    setDraggedIndex(index);
  };

  // Handle drag over
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (!editable) return;
    dragOverItem.current = index;
  };

  // Handle drop
  const handleDrop = () => {
    if (
      !editable ||
      dragItem.current === null ||
      dragOverItem.current === null
    ) {
      return;
    }

    const newServices = [...sortedServices];
    const draggedItem = newServices[dragItem.current];

    // Remove dragged item
    newServices.splice(dragItem.current, 1);
    // Insert at new position
    newServices.splice(dragOverItem.current, 0, draggedItem);

    // Update order numbers
    const reorderedServices = newServices.map((service, index) => ({
      ...service,
      order: index,
    }));

    if (onReorder) {
      onReorder(reorderedServices);
    }

    setDraggedIndex(null);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  // Handle drag end
  const handleDragEnd = () => {
    setDraggedIndex(null);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  // Handle time edit
  const handleTimeEdit = (service: ServiceItem) => {
    if (!editable) return;
    setEditingTimeId(service.id);
    setTempStartTime(formatTime(service.scheduledStart));
  };

  // Handle time save
  const handleTimeSave = (service: ServiceItem) => {
    if (!onTimeChange || !tempStartTime) {
      setEditingTimeId(null);
      return;
    }

    // Parse the new start time
    const [hours, minutes] = tempStartTime.split(":").map(Number);
    const originalStart = new Date(service.scheduledStart);
    const newStart = new Date(originalStart);
    newStart.setHours(hours, minutes, 0, 0);

    // Calculate new end time based on duration
    const newEnd = new Date(newStart.getTime() + service.duration * 60000);

    onTimeChange(service.id, newStart.toISOString(), newEnd.toISOString());
    setEditingTimeId(null);
  };

  // Handle mode toggle
  const handleModeToggle = (service: ServiceItem) => {
    if (!editable || !onModeToggle) return;
    onModeToggle(service.id, !service.isParallel);
  };

  // Calculate timeline position
  const getTimelinePosition = (service: ServiceItem) => {
    const startTime = new Date(service.scheduledStart);
    const endTime = new Date(service.scheduledEnd);

    // Find the earliest start time among all services
    const earliestStart = Math.min(
      ...sortedServices.map((s) => new Date(s.scheduledStart).getTime()),
    );

    // Calculate position relative to earliest start
    const startOffset = (startTime.getTime() - earliestStart) / 60000; // minutes
    const duration = (endTime.getTime() - startTime.getTime()) / 60000; // minutes

    return { startOffset, duration };
  };

  // Find the total timeline duration
  const totalDuration = sortedServices.reduce((total, service) => {
    const { startOffset, duration } = getTimelinePosition(service);
    return Math.max(total, startOffset + duration);
  }, 0);

  return (
    <div className="space-y-4">
      {/* Timeline Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center">
          <Clock className="w-5 h-5 mr-2 text-indigo-600" />
          {t("appointments.service_timeline")}
        </h3>
        {editable && (
          <span className="text-xs text-gray-500">
            {t("appointments.drag_to_reorder_click_to_edit")}
          </span>
        )}
      </div>

      {/* Visual Timeline */}
      <div className="relative bg-gray-100 rounded-lg p-4 min-h-[120px]">
        {/* Time markers */}
        <div className="flex justify-between text-xs text-gray-500 mb-2">
          {Array.from({ length: Math.ceil(totalDuration / 30) + 1 }).map(
            (_, i) => (
              <span key={i}>{i * 30}m</span>
            ),
          )}
        </div>

        {/* Service blocks */}
        <div className="relative h-16">
          {sortedServices.map((service, index) => {
            const { startOffset, duration } = getTimelinePosition(service);
            const leftPercent = (startOffset / totalDuration) * 100;
            const widthPercent = (duration / totalDuration) * 100;

            return (
              <div
                key={service.id}
                className={`absolute h-12 rounded-lg border-2 transition-all ${
                  service.isParallel
                    ? "bg-blue-100 border-blue-300"
                    : "bg-purple-100 border-purple-300"
                } ${draggedIndex === index ? "opacity-50" : ""}`}
                style={{
                  left: `${leftPercent}%`,
                  width: `${widthPercent}%`,
                  top: service.isParallel ? "0" : "24px",
                }}
                draggable={editable}
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              >
                <div className="flex items-center h-full px-2 overflow-hidden">
                  {editable && (
                    <GripVertical className="w-4 h-4 text-gray-400 mr-1 cursor-grab" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-900 truncate">
                      {service.serviceName}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {formatTime(service.scheduledStart)} -{" "}
                      {formatTime(service.scheduledEnd)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center space-x-4 mt-4 text-xs">
          <div className="flex items-center">
            <div className="w-3 h-3 bg-purple-100 border border-purple-300 rounded mr-1" />
            <span>Serial</span>
          </div>
          <div className="flex items-center">
            <div className="w-3 h-3 bg-blue-100 border border-blue-300 rounded mr-1" />
            <span>Parallel</span>
          </div>
        </div>
      </div>

      {/* Service List */}
      <div className="space-y-2">
        {sortedServices.map((service, index) => (
          <div
            key={service.id}
            className={`flex items-center p-3 rounded-lg border ${
              service.isParallel
                ? "bg-blue-50 border-blue-200"
                : "bg-purple-50 border-purple-200"
            } ${draggedIndex === index ? "opacity-50" : ""}`}
            draggable={editable}
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          >
            {/* Drag Handle */}
            {editable && (
              <GripVertical className="w-5 h-5 text-gray-400 mr-3 cursor-grab" />
            )}

            {/* Service Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-2">
                <span className="font-medium text-gray-900">
                  {service.serviceName}
                </span>
                {service.isParallel && (
                  <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                    Parallel
                  </span>
                )}
              </div>
              {service.professionalName && (
                <div className="flex items-center text-sm text-gray-500 mt-1">
                  <Users className="w-4 h-4 mr-1" />
                  {service.professionalName}
                </div>
              )}
            </div>

            {/* Time Display/Edit */}
            <div className="flex items-center space-x-2">
              {editingTimeId === service.id ? (
                <div className="flex items-center space-x-2">
                  <input
                    type="time"
                    value={tempStartTime}
                    onChange={(e) => setTempStartTime(e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded text-sm"
                  />
                  <button
                    onClick={() => handleTimeSave(service)}
                    className="px-2 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingTimeId(null)}
                    className="px-2 py-1 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div
                  className={`text-sm ${editable ? "cursor-pointer hover:text-indigo-600" : ""}`}
                  onClick={() => handleTimeEdit(service)}
                >
                  <span className="font-medium">
                    {formatTime(service.scheduledStart)}
                  </span>
                  <ArrowRight className="w-4 h-4 inline mx-1" />
                  <span className="font-medium">
                    {formatTime(service.scheduledEnd)}
                  </span>
                </div>
              )}
            </div>

            {/* Mode Toggle */}
            {editable && onModeToggle && (
              <button
                onClick={() => handleModeToggle(service)}
                className={`ml-3 px-2 py-1 text-xs rounded ${
                  service.isParallel
                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                    : "bg-purple-100 text-purple-700 hover:bg-purple-200"
                }`}
              >
                {service.isParallel ? "Parallel" : "Serial"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

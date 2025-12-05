import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  CanvasState,
  CanvasElement,
  ViewportState,
  ShapeElement,
  ImageElement,
  TextElement,
  GroupElement,
  ArrowBinding,
} from '../types';
import { ElementType, ImageFilter } from '../types';
import { generateId, cloneElement, debounce } from '../utils/helpers';
import { saveCanvasState, loadCanvasState } from '../utils/storage';

const DEFAULT_VIEWPORT: ViewportState = {
  x: 0,
  y: 0,
  scale: 1,
};

export const useCanvasState = () => {
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  const [viewport, setViewport] = useState<ViewportState>(DEFAULT_VIEWPORT);
  const viewportRef = useRef<ViewportState>(DEFAULT_VIEWPORT);
  const [clipboard, setClipboard] = useState<CanvasElement[]>([]);
  const [initialized, setInitialized] = useState(false);
  
  // History for undo/redo (store full snapshot: elements + selectedIds + viewport)
  const [history, setHistory] = useState<Array<{ elements: CanvasElement[]; selectedIds: string[]; viewport: ViewportState }>>([]);
  const historyRef = useRef<Array<{ elements: CanvasElement[]; selectedIds: string[]; viewport: ViewportState }>>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyIndexRef = useRef(-1);
  const [] = useState(false);
  const isUndoRedoActionRef = useRef(false);
  const suppressAutoHistoryRef = useRef(false);
  const batchUpdateRef = useRef(false);
  const historyLengthRef = useRef(0);
  // 跳过 effect 的计数器：undo/redo 后需要跳过多次 effect（elements、viewport、selectedIds 各一次）
  const skipEffectCountRef = useRef(0);

  // 加载初始状态
  useEffect(() => {
    const savedState = loadCanvasState();
    if (savedState && savedState.elements && savedState.elements.length > 0) {
      setElements([...savedState.elements]);
      if (savedState.viewport) {
        setViewport({...savedState.viewport});
      }
      // 初始化历史记录，包含 elements、selectedIds 和 viewport
      const initialSnapshot = { elements: [...savedState.elements], selectedIds: [], viewport: savedState.viewport || DEFAULT_VIEWPORT };
      setHistory([initialSnapshot]);
      historyRef.current = [initialSnapshot];
      setHistoryIndex(0);
      historyIndexRef.current = 0;
      historyLengthRef.current = 1;
    } else {
      // 没有保存的状态，创建初始元素
      const initialElements = createInitialElements();
      setElements(initialElements);
      // 初始化历史记录
      const initialSnapshot = { elements: [...initialElements], selectedIds: [], viewport: DEFAULT_VIEWPORT };
      setHistory([initialSnapshot]);
      historyRef.current = [initialSnapshot];
      setHistoryIndex(0);
      historyIndexRef.current = 0;
      historyLengthRef.current = 1;
    }
    setInitialized(true);
  }, []);

  // 自动保存到 localStorage
  const debouncedSave = useCallback(
    debounce((state: CanvasState) => {
      saveCanvasState(state);
    }, 500),
    []
  );

  useEffect(() => {
    if (!initialized) return;
    debouncedSave({ elements, selectedIds, viewport });
  }, [elements, viewport, selectedIds, debouncedSave, initialized]);

  // 同步historyIndex到ref
  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  // 同步history到ref
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // selectedIds / viewport refs for immediate history snapshot
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);

  const elementsRef = useRef<CanvasElement[]>([]);
  useEffect(() => { elementsRef.current = elements; }, [elements]);

  // 添加到历史记录（防抖处理）
  const addToHistoryImmediate = useCallback((snapshot: { elements: CanvasElement[]; selectedIds: string[]; viewport: ViewportState }) => {
    // 如果当前正在执行撤销/重做，则跳过添加历史
    if (isUndoRedoActionRef.current) {
      console.log('⏭️ Skipping history add during undo/redo');
      return;
    }
    // 如果处于批量更新中（例如拖拽），则跳过中间历史
    if (batchUpdateRef.current) return;

    setHistory((prev) => {
      const currentIndex = historyIndexRef.current;
      const newHistory = prev.slice(0, currentIndex + 1);
      newHistory.push({ elements: [...snapshot.elements], selectedIds: [...snapshot.selectedIds], viewport: { ...snapshot.viewport } });
      // 限制历史记录数量（最多50条）
      if (newHistory.length > 50) {
        newHistory.shift();
      }
      // 更新 historyIndexRef 和 state
      const newIndex = newHistory.length - 1;
      historyIndexRef.current = newIndex;
      historyRef.current = newHistory;
      setHistoryIndex(newIndex);
      historyLengthRef.current = newHistory.length;
      console.log('[HISTORY] Added snapshot, new length:', newHistory.length, 'new index:', newIndex);
      return newHistory;
    });
  }, []);

  const addToHistoryDebouncedRef = useRef<number | null>(null);
  
  const addToHistoryDebounced = useCallback((snapshot: { elements: CanvasElement[]; selectedIds: string[]; viewport: ViewportState }) => {
    if (addToHistoryDebouncedRef.current) {
      clearTimeout(addToHistoryDebouncedRef.current);
    }
    addToHistoryDebouncedRef.current = window.setTimeout(() => {
      addToHistoryImmediate(snapshot);
      addToHistoryDebouncedRef.current = null;
    }, 300);
  }, [addToHistoryImmediate]);

  const pushHistorySnapshot = useCallback((newElements?: CanvasElement[], overrideSelectedIds?: string[], overrideViewport?: ViewportState) => {
    // 如果是撤销/重做操作，不保存历史
    if (isUndoRedoActionRef.current) return;
    suppressAutoHistoryRef.current = true;
    
    const snapshot = {
      elements: newElements ? [...newElements] : [...elementsRef.current],
      selectedIds: overrideSelectedIds ? [...overrideSelectedIds] : [...selectedIdsRef.current],
      viewport: overrideViewport ? { ...overrideViewport } : { ...viewportRef.current },
    };
    addToHistoryImmediate(snapshot);
  }, [addToHistoryImmediate]);

  // Batch update helpers: used for drag operations to avoid recording intermediate states
  const beginBatchUpdate = useCallback(() => {
    // push pre-drag snapshot (start state)
    pushHistorySnapshot();
    batchUpdateRef.current = true;
  }, [pushHistorySnapshot]);

  const endBatchUpdate = useCallback(() => {
    batchUpdateRef.current = false;
    // push final snapshot after batch
    pushHistorySnapshot();
  }, [pushHistorySnapshot]);

  // 监听elements变化，添加到历史记录
  useEffect(() => {
    if (!initialized) return;
    if (elements.length === 0 && history.length === 0) return;
    
    console.log('[EFFECT] elements changed, skipCount:', skipEffectCountRef.current, 'suppressAutoHistory:', suppressAutoHistoryRef.current, 'batchUpdate:', batchUpdateRef.current);
    
    // 如果需要跳过此次 effect（undo/redo 后的状态更新）
    if (skipEffectCountRef.current > 0) {
      console.log('[EFFECT] Skipping due to skipEffectCount:', skipEffectCountRef.current);
      skipEffectCountRef.current--;
      // 清除任何待处理的防抖调用
      if (addToHistoryDebouncedRef.current) {
        clearTimeout(addToHistoryDebouncedRef.current);
        addToHistoryDebouncedRef.current = null;
      }
      return;
    }
    
    if (suppressAutoHistoryRef.current) {
      console.log('[EFFECT] Clearing suppressAutoHistory flag');
      suppressAutoHistoryRef.current = false;
      return;
    }
    
    // 批量更新中不记录历史
    if (batchUpdateRef.current) {
      console.log('[EFFECT] Skipping due to batch update');
      return;
    }
    
    // 仅当历史长度没变化时才防抖保存（避免手动快照后重复保存）
    if (historyLengthRef.current === history.length) {
      console.log('[EFFECT] Scheduling debounced history save');
      addToHistoryDebounced({ elements, selectedIds, viewport });
    } else {
      console.log('[EFFECT] Skipping debounced save, history length changed');
    }
  }, [elements, viewport, selectedIds, initialized, history.length, addToHistoryDebounced]);

  // 创建初始元素
  const createInitialElements = (): CanvasElement[] => {
    return [
      {
        id: generateId(),
        type: ElementType.RECTANGLE,
        x: 100,
        y: 100,
        width: 200,
        height: 150,
        rotation: 0,
        zIndex: 0,
        backgroundColor: '#3b82f6',
        borderWidth: 2,
        borderColor: '#1e40af',
        textRangeStyles: [],
      } as ShapeElement,
      {
        id: generateId(),
        type: ElementType.ROUNDED_RECTANGLE,
        x: 350,
        y: 100,
        width: 200,
        height: 150,
        rotation: 0,
        zIndex: 1,
        backgroundColor: '#10b981',
        borderWidth: 2,
        borderColor: '#059669',
        cornerRadius: 20,
        textRangeStyles: [],
      } as ShapeElement,
      {
        id: generateId(),
        type: ElementType.CIRCLE,
        x: 600,
        y: 100,
        width: 150,
        height: 150,
        rotation: 0,
        zIndex: 2,
        backgroundColor: '#f59e0b',
        borderWidth: 2,
        borderColor: '#d97706',
        textRangeStyles: [],
      } as ShapeElement,
      {
        id: generateId(),
        type: ElementType.TRIANGLE,
        x: 850,
        y: 100,
        width: 150,
        height: 150,
        rotation: 0,
        zIndex: 3,
        backgroundColor: '#ef4444',
        borderWidth: 2,
        borderColor: '#dc2626',
        textRangeStyles: [],
      } as ShapeElement,
      {
        id: generateId(),
        type: ElementType.ARROW,
        x: 150,
        y: 280,
        width: 220,
        height: 80,
        rotation: 0,
        zIndex: 4,
        backgroundColor: 'transparent',
        borderWidth: 4,
        borderColor: '#1e3a8a',
        arrowStart: { x: 20, y: 40 },
        arrowEnd: { x: 200, y: 40 },
        arrowHeadSize: 18,
        arrowTailWidth: 4,
        arrowCurve: 0,
      } as ShapeElement,
      {
        id: generateId(),
        type: ElementType.TEXT,
        x: 100,
        y: 300,
        width: 400,
        height: 100,
        rotation: 0,
        zIndex: 5,
        content: '欢迎使用画布编辑器！',
        style: {
          fontFamily: 'Arial',
          fontSize: 32,
          color: '#1f2937',
          backgroundColor: '#fef3c7',
          bold: true,
        },
        rangeStyles: [],
      } as TextElement,
    ];
  };

  // 添加元素
  const addElement = useCallback((element: CanvasElement) => {
    setElements((prev) => {
      const next = [...prev, element];
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 批量添加元素
  const addElements = useCallback((newElements: CanvasElement[]) => {
    setElements((prev) => {
      const next = [...prev, ...newElements];
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 更新元素
  const updateElement = useCallback((id: string, updates: Partial<CanvasElement>) => {
    setElements((prev) => {
      const next = prev.map((el) => {
        if (el.id === id) {
          if (el.type === 'arrow') {
            const arrowEl = el as ShapeElement;
            const shapeUpdates = updates as Partial<ShapeElement>;

            const widthUpdated = typeof shapeUpdates.width === 'number';
            const heightUpdated = typeof shapeUpdates.height === 'number';
            const newWidth = widthUpdated ? (shapeUpdates.width as number) : arrowEl.width;
            const newHeight = heightUpdated ? (shapeUpdates.height as number) : arrowEl.height;

            const scaleX = widthUpdated && arrowEl.width !== 0 ? newWidth / arrowEl.width : 1;
            const scaleY = heightUpdated && arrowEl.height !== 0 ? newHeight / arrowEl.height : 1;

            const hasNewStart = shapeUpdates.arrowStart !== undefined;
            const hasNewEnd = shapeUpdates.arrowEnd !== undefined;

            const nextStart = hasNewStart
              ? shapeUpdates.arrowStart || undefined
              : arrowEl.arrowStart
              ? {
                  x: arrowEl.arrowStart.x * scaleX,
                  y: arrowEl.arrowStart.y * scaleY,
                }
              : undefined;

            const nextEnd = hasNewEnd
              ? shapeUpdates.arrowEnd || undefined
              : arrowEl.arrowEnd
              ? {
                  x: arrowEl.arrowEnd.x * scaleX,
                  y: arrowEl.arrowEnd.y * scaleY,
                }
              : undefined;

            const merged: ShapeElement = {
              ...arrowEl,
              ...shapeUpdates,
              width: newWidth,
              height: newHeight,
              arrowStart: nextStart,
              arrowEnd: nextEnd,
            } as ShapeElement;

            return merged as CanvasElement;
          }
          // 如果是文字元素且更新了 style，需要深度合并
          if (el.type === 'text' && 'style' in updates) {
            const textEl = el as TextElement;
            const textUpdates = updates as Partial<TextElement>;
            return {
              ...textEl,
              ...textUpdates,
              style: { ...textEl.style, ...textUpdates.style },
            } as CanvasElement;
          }
          return { ...el, ...updates } as CanvasElement;
        }
        return el;
      });
      if (!batchUpdateRef.current) pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 批量更新多个元素
  const updateElements = useCallback((updates: Array<{ id: string; updates: Partial<CanvasElement> }>) => {
    setElements((prev) => {
      const updateMap = new Map(updates.map(u => [u.id, u.updates]));
      const next = prev.map((el) => {
        const update = updateMap.get(el.id);
        if (update) {
          if (el.type === 'arrow') {
            const arrowEl = el as ShapeElement;
            const shapeUpdates = update as Partial<ShapeElement>;

            const widthUpdated = typeof shapeUpdates.width === 'number';
            const heightUpdated = typeof shapeUpdates.height === 'number';
            const newWidth = widthUpdated ? (shapeUpdates.width as number) : arrowEl.width;
            const newHeight = heightUpdated ? (shapeUpdates.height as number) : arrowEl.height;

            const scaleX = widthUpdated && arrowEl.width !== 0 ? newWidth / arrowEl.width : 1;
            const scaleY = heightUpdated && arrowEl.height !== 0 ? newHeight / arrowEl.height : 1;

            const hasNewStart = shapeUpdates.arrowStart !== undefined;
            const hasNewEnd = shapeUpdates.arrowEnd !== undefined;

            const nextStart = hasNewStart
              ? shapeUpdates.arrowStart || undefined
              : arrowEl.arrowStart
              ? { x: arrowEl.arrowStart.x * scaleX, y: arrowEl.arrowStart.y * scaleY }
              : undefined;

            const nextEnd = hasNewEnd
              ? shapeUpdates.arrowEnd || undefined
              : arrowEl.arrowEnd
              ? { x: arrowEl.arrowEnd.x * scaleX, y: arrowEl.arrowEnd.y * scaleY }
              : undefined;

            return {
              ...arrowEl,
              ...shapeUpdates,
              width: newWidth,
              height: newHeight,
              arrowStart: nextStart,
              arrowEnd: nextEnd,
            } as CanvasElement;
          }
          if (el.type === 'text' && 'style' in update) {
            const textEl = el as TextElement;
            const textUpdates = update as Partial<TextElement>;
            return {
              ...textEl,
              ...textUpdates,
              style: { ...textEl.style, ...textUpdates.style },
            } as CanvasElement;
          }
          return { ...el, ...update } as CanvasElement;
        }
        return el;
      });
      if (!batchUpdateRef.current) pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 删除元素
  const deleteElements = useCallback((ids: string[]) => {
    const nextSelectedIds = selectedIdsRef.current.filter((id) => !ids.includes(id));
    setElements((prev) => {
      const next = prev.filter((el) => !ids.includes(el.id));
      pushHistorySnapshot(next, nextSelectedIds);
      return next;
    });
    setSelectedIds(nextSelectedIds);
  }, [pushHistorySnapshot]);

  // 旋转元素
  const rotateElements = useCallback((ids: string[], angle: number) => {
    if (ids.length === 0) return;

    setElements((prev) => {
      const selectedElements = prev.filter((el) => ids.includes(el.id));
      if (selectedElements.length === 0) return prev;

      // 如果只有一个元素，直接旋转
      if (selectedElements.length === 1) {
        return prev.map((el) => {
          if (el.id === ids[0]) {
            const newRotation = ((el.rotation || 0) + angle) % 360;
            return {
              ...el,
              rotation: newRotation < 0 ? newRotation + 360 : newRotation,
            };
          }
          return el;
        });
      }

      // 多个元素：计算它们的共同中心点
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      selectedElements.forEach((el) => {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + el.width);
        maxY = Math.max(maxY, el.y + el.height);
      });

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const angleRad = (angle * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);

      const next = prev.map((el) => {
        if (ids.includes(el.id)) {
          // 元素中心点
          const elCenterX = el.x + el.width / 2;
          const elCenterY = el.y + el.height / 2;

          // 相对于共同中心的位置
          const relX = elCenterX - centerX;
          const relY = elCenterY - centerY;

          // 旋转后的位置
          const newRelX = relX * cos - relY * sin;
          const newRelY = relX * sin + relY * cos;

          // 新的元素位置
          const newCenterX = centerX + newRelX;
          const newCenterY = centerY + newRelY;
          const newX = newCenterX - el.width / 2;
          const newY = newCenterY - el.height / 2;

          // 更新旋转角度
          const newRotation = ((el.rotation || 0) + angle) % 360;

          return {
            ...el,
            x: newX,
            y: newY,
            rotation: newRotation < 0 ? newRotation + 360 : newRotation,
          };
        }
        return el;
      });
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 设置元素的绝对旋转角度（用于属性面板）
  const setRotation = useCallback((ids: string[], targetRotation: number) => {
    if (ids.length === 0) return;

    setElements((prev) => {
      const selectedElements = prev.filter((el) => ids.includes(el.id));
      if (selectedElements.length === 0) return prev;

      // 如果只有一个元素，直接设置旋转角度
      if (selectedElements.length === 1) {
        return prev.map((el) => {
          if (el.id === ids[0]) {
            return {
              ...el,
              rotation: targetRotation % 360,
            };
          }
          return el;
        });
      }

      // 多个元素：计算旋转差值，然后围绕中心旋转
      // 使用第一个元素的当前旋转角度作为参考
      const currentRotation = selectedElements[0].rotation || 0;
      const angleDiff = targetRotation - currentRotation;
      
      // 如果旋转差值为0，不需要旋转
      if (Math.abs(angleDiff) < 0.001) return prev;

      // 计算共同中心点
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      selectedElements.forEach((el) => {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + el.width);
        maxY = Math.max(maxY, el.y + el.height);
      });

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const angleRad = (angleDiff * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);

      const next = prev.map((el) => {
        if (ids.includes(el.id)) {
          // 元素中心点
          const elCenterX = el.x + el.width / 2;
          const elCenterY = el.y + el.height / 2;

          // 相对于共同中心的位置
          const relX = elCenterX - centerX;
          const relY = elCenterY - centerY;

          // 旋转后的位置
          const newRelX = relX * cos - relY * sin;
          const newRelY = relX * sin + relY * cos;

          // 新的元素位置
          const newCenterX = centerX + newRelX;
          const newCenterY = centerY + newRelY;
          const newX = newCenterX - el.width / 2;
          const newY = newCenterY - el.height / 2;

          // 更新旋转角度
          const newRotation = ((el.rotation || 0) + angleDiff) % 360;

          return {
            ...el,
            x: newX,
            y: newY,
            rotation: newRotation < 0 ? newRotation + 360 : newRotation,
          };
        }
        return el;
      });
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 选择元素
  const selectElements = useCallback((ids: string[]) => {
    setSelectedIds(ids);
  }, []);

  // 切换选择
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  }, []);

  // 清空选择
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  // 更新视口
  const updateViewport = useCallback((updates: Partial<ViewportState>) => {
    setViewport((prev) => ({ ...prev, ...updates }));
  }, []);

  // 复制选中元素
  const copySelected = useCallback(() => {
    const selected = elements.filter((el) => selectedIds.includes(el.id));
    setClipboard(selected.map(cloneElement));
  }, [elements, selectedIds]);

  // 粘贴元素
  const paste = useCallback(() => {
    if (clipboard.length === 0) return;

    const newElements = clipboard.map((el) => {
      const cloned = cloneElement(el);
      cloned.id = generateId();
      cloned.x += 20;
      cloned.y += 20;
      return cloned;
    });

    const newIds = newElements.map((el) => el.id);
    setElements((prev) => {
      const next = [...prev, ...newElements];
      pushHistorySnapshot(next, newIds);
      return next;
    });
    setSelectedIds(newIds);
    setClipboard(newElements); // 更新剪贴板，方便连续粘贴
  }, [clipboard, pushHistorySnapshot]);

  // 创建新元素
  const createElement = useCallback(
    (type: ElementType, x: number, y: number, imageUrl?: string, width?: number, height?: number) => {
      let newElement: CanvasElement;

      const baseProps = {
        id: generateId(),
        x,
        y,
        rotation: 0,
        zIndex: elements.length,
      };

      switch (type) {
        case ElementType.RECTANGLE:
        case ElementType.ROUNDED_RECTANGLE:
        case ElementType.CIRCLE:
        case ElementType.TRIANGLE:
          newElement = {
            ...baseProps,
            type,
            width: 150,
            height: 150,
            backgroundColor: '#3b82f6',
            borderWidth: 2,
            borderColor: '#1e40af',
            cornerRadius: type === ElementType.ROUNDED_RECTANGLE ? 20 : undefined,
            content: '',
            textStyle: {
              fontFamily: 'Arial',
              fontSize: 16,
              color: '#ffffff',
              bold: false,
              italic: false,
              underline: false,
              strikethrough: false,
            },
            textRangeStyles: [],
          } as ShapeElement;
          break;
        case ElementType.ARROW:
          newElement = {
            ...baseProps,
            type,
            width: 180,
            height: 60,
            backgroundColor: 'transparent',
            borderWidth: 4,
            borderColor: '#2563eb',
            arrowStart: { x: 20, y: 30 },
            arrowEnd: { x: 160, y: 30 },
            arrowHeadSize: 18,
            arrowTailWidth: 4,
            arrowCurve: 0,
          } as ShapeElement;
          break;
        case ElementType.TEXT:
          newElement = {
            ...baseProps,
            type,
            width: 300,
            height: 80,
            content: '双击编辑文本',
            style: {
              fontFamily: 'Arial',
              fontSize: 24,
              color: '#000000',
              bold: false,
              italic: false,
              underline: false,
              strikethrough: false,
            },
            rangeStyles: [],
          } as TextElement;
          break;
        case ElementType.IMAGE:
          // 使用传入的图片URL和尺寸，或使用默认值
          newElement = {
            ...baseProps,
            type,
            width: width || 200,
            height: height || 200,
            src: imageUrl || 'https://via.placeholder.com/200',
            filter: ImageFilter.NONE,
          } as ImageElement;
          break;
        default:
          return;
      }

      addElement(newElement);
      selectElements([newElement.id]);
    },
    [elements.length, addElement, selectElements]
  );

  // 获取选中的元素
  const getSelectedElements = useCallback(() => {
    return elements.filter((el) => selectedIds.includes(el.id));
  }, [elements, selectedIds]);

  // 创建箭头（使用指定的起点和终点）
  const createArrowWithPoints = useCallback(
    (startX: number, startY: number, endX: number, endY: number, startBinding?: ArrowBinding, endBinding?: ArrowBinding) => {
      // 计算箭头的边界框
      const minX = Math.min(startX, endX);
      const minY = Math.min(startY, endY);
      const width = Math.max(Math.abs(endX - startX), 50);
      const height = Math.max(Math.abs(endY - startY), 50);
      
      // 转换为相对于边界框的坐标
      const relativeStartX = startX - minX;
      const relativeStartY = startY - minY;
      const relativeEndX = endX - minX;
      const relativeEndY = endY - minY;
      
      const newArrow: ShapeElement = {
        id: generateId(),
        type: ElementType.ARROW,
        x: minX,
        y: minY,
        width: width,
        height: height,
        rotation: 0,
        zIndex: elements.length,
        backgroundColor: 'transparent',
        borderWidth: 4,
        borderColor: '#2563eb',
        arrowStart: { x: relativeStartX, y: relativeStartY },
        arrowEnd: { x: relativeEndX, y: relativeEndY },
        arrowHeadSize: 18,
        arrowTailWidth: 4,
        arrowCurve: 0,
        startBinding: startBinding,
        endBinding: endBinding,
      };
      
      const newSel = [newArrow.id];
      setElements((prev) => {
        const next = [...prev, newArrow];
        pushHistorySnapshot(next, newSel);
        return next;
      });
      setSelectedIds(newSel);
    },
    [elements.length, pushHistorySnapshot]
  );

  // 更新箭头的起点或终点位置（接收绝对画布坐标）
  const updateArrowPoint = useCallback(
    (elementId: string, point: 'start' | 'end', absoluteX: number, absoluteY: number, binding?: ArrowBinding) => {
      setElements((prev) =>
        prev.map((el) => {
          if (el.id !== elementId || el.type !== ElementType.ARROW) {
            return el;
          }

          const shapeEl = el as ShapeElement;
          
          // 获取另一个端点的绝对坐标
          const otherPoint = point === 'start' ? shapeEl.arrowEnd! : shapeEl.arrowStart!;
          const otherAbsoluteX = shapeEl.x + otherPoint.x;
          const otherAbsoluteY = shapeEl.y + otherPoint.y;
          
          // 当前拖动的点使用传入的绝对坐标
          const startAbsX = point === 'start' ? absoluteX : otherAbsoluteX;
          const startAbsY = point === 'start' ? absoluteY : otherAbsoluteY;
          const endAbsX = point === 'end' ? absoluteX : otherAbsoluteX;
          const endAbsY = point === 'end' ? absoluteY : otherAbsoluteY;
          
          // 更新绑定信息
          const updatedStartBinding = point === 'start' ? binding : shapeEl.startBinding;
          const updatedEndBinding = point === 'end' ? binding : shapeEl.endBinding;
          
          // 计算新的边界框
          const minX = Math.min(startAbsX, endAbsX);
          const minY = Math.min(startAbsY, endAbsY);
          const width = Math.max(Math.abs(endAbsX - startAbsX), 10);
          const height = Math.max(Math.abs(endAbsY - startAbsY), 10);
          
          // 转换为相对坐标
          const relativeStartX = startAbsX - minX;
          const relativeStartY = startAbsY - minY;
          const relativeEndX = endAbsX - minX;
          const relativeEndY = endAbsY - minY;
          
          return {
            ...shapeEl,
            x: minX,
            y: minY,
            width,
            height,
            arrowStart: { x: relativeStartX, y: relativeStartY },
            arrowEnd: { x: relativeEndX, y: relativeEndY },
            startBinding: updatedStartBinding,
            endBinding: updatedEndBinding,
          };
        })
      );
    },
    []
  );

  // 组合元素
  const groupElements = useCallback((ids: string[]) => {
    if (ids.length < 2) return;
    
    const newGroupId = generateId();

    setElements((prev) => {
      const elementsToGroup = prev.filter((el) => ids.includes(el.id));
      if (elementsToGroup.length < 2) return prev;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      elementsToGroup.forEach((el) => {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + el.width);
        maxY = Math.max(maxY, el.y + el.height);
      });

      const groupX = minX;
      const groupY = minY;
      const groupWidth = maxX - minX;
      const groupHeight = maxY - minY;

      const children = elementsToGroup.map((el) => ({
        ...el,
        x: el.x - groupX,
        y: el.y - groupY,
      }));
      

      const newGroup: GroupElement = {
        id: newGroupId,
        type: 'group',
        x: groupX,
        y: groupY,
        width: groupWidth,
        height: groupHeight,
        rotation: 0,
        zIndex: Math.max(...elementsToGroup.map((e) => e.zIndex)),
        children: children,
      };

      const remaining = prev.filter((el) => !ids.includes(el.id));
      const next = [...remaining, newGroup];
      pushHistorySnapshot(next, [newGroupId]);
      return next;
    });
    
    setSelectedIds([newGroupId]);
  }, [pushHistorySnapshot]);

  // 取消组合
  const ungroupElements = useCallback((ids: string[]) => {
    let newSelectedIds: string[] = [];

    setElements((prev) => {
      let newElements = [...prev];
      const groupsToUngroup = newElements.filter(el => ids.includes(el.id) && el.type === 'group');
      
      if (groupsToUngroup.length === 0) return prev;

      groupsToUngroup.forEach(group => {
        const groupEl = group as GroupElement;
        // Remove group
        newElements = newElements.filter(el => el.id !== group.id);
        
        // Calculate scale
        let minChildX = Infinity, minChildY = Infinity, maxChildX = -Infinity, maxChildY = -Infinity;
        groupEl.children.forEach(c => {
            minChildX = Math.min(minChildX, c.x);
            minChildY = Math.min(minChildY, c.y);
            maxChildX = Math.max(maxChildX, c.x + c.width);
            maxChildY = Math.max(maxChildY, c.y + c.height);
        });
        
        const naturalWidth = Math.max(maxChildX - minChildX, 1);
        const naturalHeight = Math.max(maxChildY - minChildY, 1);
        
        const scaleX = groupEl.width / naturalWidth;
        const scaleY = groupEl.height / naturalHeight;

        const groupRotation = (groupEl.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(groupRotation);
        const sin = Math.sin(groupRotation);
        
        const children = groupEl.children.map(child => {
            // Apply scale
            const scaledWidth = child.width * scaleX;
            const scaledHeight = child.height * scaleY;
            const scaledX = child.x * scaleX;
            const scaledY = child.y * scaleY;

            // Child center relative to group center
            const childCenterX = scaledX + scaledWidth / 2;
            const childCenterY = scaledY + scaledHeight / 2;
            
            const groupCenterX = groupEl.width / 2;
            const groupCenterY = groupEl.height / 2;
            
            // Vector from group center to child center
            const dx = childCenterX - groupCenterX;
            const dy = childCenterY - groupCenterY;
            
            // Rotate vector
            const rotatedDx = dx * cos - dy * sin;
            const rotatedDy = dx * sin + dy * cos;
            
            // New absolute center
            const absCenterX = groupEl.x + groupCenterX + rotatedDx;
            const absCenterY = groupEl.y + groupCenterY + rotatedDy;
            
            // New absolute top-left
            const absX = absCenterX - scaledWidth / 2;
            const absY = absCenterY - scaledHeight / 2;
            
            let extraProps = {};
            if (child.type === 'arrow') {
                const arrowChild = child as ShapeElement;
                extraProps = {
                    arrowStart: arrowChild.arrowStart ? { x: arrowChild.arrowStart.x * scaleX, y: arrowChild.arrowStart.y * scaleY } : undefined,
                    arrowEnd: arrowChild.arrowEnd ? { x: arrowChild.arrowEnd.x * scaleX, y: arrowChild.arrowEnd.y * scaleY } : undefined,
                };
            }
            
            return {
                ...child,
                x: absX,
                y: absY,
                width: scaledWidth,
                height: scaledHeight,
                rotation: ((child.rotation || 0) + (groupEl.rotation || 0)) % 360,
                zIndex: groupEl.zIndex,
                ...extraProps
            };
        });
        
        newElements.push(...children);
        newSelectedIds.push(...children.map(c => c.id));
      });
      
      pushHistorySnapshot(newElements, newSelectedIds);
      return newElements;
    });
    
    if (newSelectedIds.length > 0) {
      setSelectedIds(newSelectedIds);
    }
  }, [pushHistorySnapshot]);

  // Undo操作
  const undo = useCallback(() => {
    const currentIdx = historyIndexRef.current;
    const currentHistory = historyRef.current;
    
    console.log('[UNDO] currentIdx:', currentIdx, 'historyLength:', currentHistory.length);
    
    if (currentIdx <= 0) {
      console.log('[UNDO] Cannot undo: at beginning');
      return;
    }

    const targetIdx = currentIdx - 1;
    const prevSnapshot = currentHistory[targetIdx];
    if (!prevSnapshot) {
      console.log('[UNDO] No snapshot at targetIdx:', targetIdx);
      return;
    }

    console.log('[UNDO] Applying snapshot at index:', targetIdx);

    // 设置跳过计数：elements、selectedIds、viewport 三个状态变化会触发多次 effect
    // 设为较大值以确保所有相关 effect 都被跳过
    skipEffectCountRef.current = 5;
    
    // 清除任何待处理的防抖调用
    if (addToHistoryDebouncedRef.current) {
      clearTimeout(addToHistoryDebouncedRef.current);
      addToHistoryDebouncedRef.current = null;
    }

    // 立即更新 ref，防止连续操作读取到旧值
    historyIndexRef.current = targetIdx;
    setHistoryIndex(targetIdx);

    setElements([...prevSnapshot.elements]);
    setSelectedIds([...prevSnapshot.selectedIds]);
    setViewport({ ...prevSnapshot.viewport });
  }, []);

  // Redo操作
  const redo = useCallback(() => {
    const currentIdx = historyIndexRef.current;
    const currentHistory = historyRef.current;
    
    console.log('[REDO] currentIdx:', currentIdx, 'historyLength:', currentHistory.length);
    
    if (currentIdx >= currentHistory.length - 1) {
      console.log('[REDO] Cannot redo: at end');
      return;
    }

    const targetIdx = currentIdx + 1;
    const nextSnapshot = currentHistory[targetIdx];
    if (!nextSnapshot) {
      console.log('[REDO] No snapshot at targetIdx:', targetIdx);
      return;
    }

    console.log('[REDO] Applying snapshot at index:', targetIdx);

    // 设置跳过计数：elements、selectedIds、viewport 三个状态变化会触发多次 effect
    skipEffectCountRef.current = 5;
    
    // 清除任何待处理的防抖调用
    if (addToHistoryDebouncedRef.current) {
      clearTimeout(addToHistoryDebouncedRef.current);
      addToHistoryDebouncedRef.current = null;
    }

    historyIndexRef.current = targetIdx;
    setHistoryIndex(targetIdx);

    setElements([...nextSnapshot.elements]);
    setSelectedIds([...nextSnapshot.selectedIds]);
    setViewport({ ...nextSnapshot.viewport });
  }, []);

  // 检查是否可以undo/redo
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;
  
  // 调试：输出当前历史状态
  useEffect(() => {
    console.log('[HISTORY STATE] index:', historyIndex, 'length:', history.length, 'canUndo:', canUndo, 'canRedo:', canRedo);
  }, [historyIndex, history.length, canUndo, canRedo]);

  // 将数组 compact 成 0..n-1 的 zIndex，并按传入 order 设置
  const compactZIndices = (orderedElements: CanvasElement[]) => {
    return orderedElements.map((el, idx) => ({ ...el, zIndex: idx }));
  };

  // 把选中的元素移动到最上层（保持选中元素之间原有顺序）
  const bringToFront = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setElements((prev) => {
      // 先按现有 z 索引排序
      const sorted = [...prev].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      const selected = sorted.filter((el) => ids.includes(el.id));
      const others = sorted.filter((el) => !ids.includes(el.id));

      const newOrder = [...others, ...selected];
      const next = compactZIndices(newOrder);
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 把选中的元素移动到最底层（保持选中元素之间原有顺序）
  const sendToBack = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setElements((prev) => {
      const sorted = [...prev].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      const selected = sorted.filter((el) => ids.includes(el.id));
      const others = sorted.filter((el) => !ids.includes(el.id));
      const newOrder = [...selected, ...others];
      const next = compactZIndices(newOrder);
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 将选中的元素上移一层（交换位置）
  const bringForward = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setElements((prev) => {
      const sorted = [...prev].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      const idSet = new Set(ids);
      // 从前往后遍历，将选中的元素和它上方的第一个非选中元素交换
      for (let i = 0; i < sorted.length; i++) {
        if (idSet.has(sorted[i].id)) {
          // 找到它上方第一个非选中元素
          let j = i + 1;
          while (j < sorted.length && idSet.has(sorted[j].id)) {
            j++;
          }
          // 如果找到了非选中元素，则交换
          if (j < sorted.length) {
            const temp = sorted[i];
            sorted[i] = sorted[j];
            sorted[j] = temp;
          }
        }
      }
      const next = compactZIndices(sorted);
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  // 将选中的元素下移一层（交换位置）
  const sendBackward = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setElements((prev) => {
      const sorted = [...prev].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      const idSet = new Set(ids);
      // 从后往前遍历，将选中的元素和它下方的第一个非选中元素交换
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (idSet.has(sorted[i].id)) {
          // 找到它下方第一个非选中元素
          let j = i - 1;
          while (j >= 0 && idSet.has(sorted[j].id)) {
            j--;
          }
          // 如果找到了非选中元素，则交换
          if (j >= 0) {
            const temp = sorted[i];
            sorted[i] = sorted[j];
            sorted[j] = temp;
          }
        }
      }
      const next = compactZIndices(sorted);
      pushHistorySnapshot(next);
      return next;
    });
  }, [pushHistorySnapshot]);

  return {
    elements,
    selectedIds,
    viewport,
    addElement,
    addElements,
    updateElement,
    updateElements,
    deleteElements,
    rotateElements,
    setRotation,
    selectElements,
    toggleSelection,
    clearSelection,
    updateViewport,
    copySelected,
    paste,
    createElement,
    createArrowWithPoints,
    updateArrowPoint,
    getSelectedElements,
    undo,
    redo,
    canUndo,
    canRedo,
    groupElements,
    ungroupElements,
    bringToFront,
    sendToBack,
    bringForward,
    sendBackward,
    beginBatchUpdate,
    endBatchUpdate,
  };
};

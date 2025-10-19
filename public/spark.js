// ClickSpark - Vanilla JS Canvas implementation
// Based on React component from https://reactbits.dev/animations/click-spark

// Global spark manager (singleton)
class ClickSparkManager {
    constructor() {
        if (ClickSparkManager.instance) {
            return ClickSparkManager.instance;
        }
        
        this.sparks = [];
        this.animationId = null;
        this.canvas = null;
        this.ctx = null;
        
        this.initCanvas();
        this.startAnimation();
        
        ClickSparkManager.instance = this;
    }
    
    initCanvas() {
        // Create canvas overlay
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'click-spark-canvas';
        this.canvas.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 9999;
        `;
        
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
        
        document.body.appendChild(this.canvas);
        
        // Handle window resize
        window.addEventListener('resize', () => this.resizeCanvas());
    }
    
    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    easeFunc(t, easing) {
        switch (easing) {
            case 'linear':
                return t;
            case 'ease-in':
                return t * t;
            case 'ease-in-out':
                return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
            default: // 'ease-out'
                return t * (2 - t);
        }
    }
    
    addSpark(x, y, options, buttonElement = null) {
        const {
            sparkColor = '#fff',
            sparkSize = 10,
            sparkRadius = 15,
            sparkCount = 8,
            duration = 400,
            easing = 'ease-out',
            extraScale = 1.0
        } = options;
        
        const now = performance.now();
        const newSparks = Array.from({ length: sparkCount }, (_, i) => ({
            buttonElement, // Store reference to button for position tracking
            initialX: x,
            initialY: y,
            angle: (2 * Math.PI * i) / sparkCount,
            startTime: now,
            sparkColor,
            sparkSize,
            sparkRadius,
            duration,
            easing,
            extraScale
        }));
        
        this.sparks.push(...newSparks);
    }
    
    draw(timestamp) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.sparks = this.sparks.filter(spark => {
            const elapsed = timestamp - spark.startTime;
            if (elapsed >= spark.duration) {
                return false;
            }
            
            // Update spark position if button element exists and has moved
            let currentX = spark.initialX;
            let currentY = spark.initialY;
            
            if (spark.buttonElement) {
                const rect = spark.buttonElement.getBoundingClientRect();
                currentX = rect.left + rect.width / 2;
                currentY = rect.top + rect.height / 2;
            }
            
            const progress = elapsed / spark.duration;
            const eased = this.easeFunc(progress, spark.easing);
            
            const distance = eased * spark.sparkRadius * spark.extraScale;
            const lineLength = spark.sparkSize * (1 - eased);
            
            const x1 = currentX + distance * Math.cos(spark.angle);
            const y1 = currentY + distance * Math.sin(spark.angle);
            const x2 = currentX + (distance + lineLength) * Math.cos(spark.angle);
            const y2 = currentY + (distance + lineLength) * Math.sin(spark.angle);
            
            this.ctx.strokeStyle = spark.sparkColor;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.stroke();
            
            return true;
        });
    }
    
    startAnimation() {
        const animate = (timestamp) => {
            this.draw(timestamp);
            this.animationId = requestAnimationFrame(animate);
        };
        
        this.animationId = requestAnimationFrame(animate);
    }
}

// Initialize global manager when script loads
let globalSparkManager = null;

function getSparkManager() {
    if (!globalSparkManager) {
        globalSparkManager = new ClickSparkManager();
    }
    return globalSparkManager;
}

// Wrapper function to mimic React component API
function ClickSpark(options) {
    const { 
        children, 
        sparkColor = '#fff',
        sparkSize = 10,
        sparkRadius = 15,
        sparkCount = 8,
        duration = 400,
        easing = 'ease-out',
        extraScale = 1.0
    } = options;
    
    if (!children) return null;
    
    const sparkOptions = {
        sparkColor,
        sparkSize,
        sparkRadius,
        sparkCount,
        duration,
        easing,
        extraScale
    };
    
    // Handle single element
    if (children && children.nodeType === Node.ELEMENT_NODE) {
        const element = children;
        
        element.addEventListener('click', (e) => {
            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const manager = getSparkManager();
            manager.addSpark(centerX, centerY, sparkOptions, element);
        });
        
        return element;
    }
    
    // Handle array of elements
    if (Array.isArray(children)) {
        children.forEach(child => {
            if (child && child.nodeType === Node.ELEMENT_NODE) {
                child.addEventListener('click', (e) => {
                    const rect = child.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    
                    const manager = getSparkManager();
                    manager.addSpark(centerX, centerY, sparkOptions, child);
                });
            }
        });
        return children;
    }
    
    return children;
}

// Export to global scope
window.ClickSpark = ClickSpark;

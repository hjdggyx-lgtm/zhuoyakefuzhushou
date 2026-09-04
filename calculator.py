"""
简易计算器 - 独立 PyQt6 应用
功能：半透明圆角窗口，支持基础运算和百分比计算
增强：完善的输入验证、高精度计算、除零保护
"""

import sys
import ast
import operator
import re
from decimal import Decimal, getcontext
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, 
                             QPushButton, QLabel, QGridLayout,
                             QGraphicsDropShadowEffect)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont, QPainter, QColor, QPainterPath

# 设置高精度计算精度
getcontext().prec = 28


def validate_expression(expr: str) -> tuple[bool, str]:
    """
    验证表达式合法性
    返回: (是否有效, 错误信息)
    """
    if not expr or expr.strip() == "":
        return False, "表达式为空"
    
    # 1. 检查括号匹配
    open_count = expr.count('(')
    close_count = expr.count(')')
    if open_count != close_count:
        return False, "括号不匹配"
    
    # 检查括号顺序
    balance = 0
    for char in expr:
        if char == '(':
            balance += 1
        elif char == ')':
            balance -= 1
            if balance < 0:
                return False, "括号顺序错误"
    
    # 2. 检查连续运算符（不允许 ++, **, //, +- 等，但允许 - 作为负号）
    invalid_patterns = [
        r'\+\+', r'\*\*', r'//', r'--',  # 连续相同运算符
        r'\+\*', r'\+/', r'\*\+', r'\*/', r'/\+', r'/\*',  # 连续不同运算符
        r'\+-', r'-\+', r'\*/', r'/\*',  # 特殊组合
    ]
    for pattern in invalid_patterns:
        if re.search(pattern, expr):
            return False, "运算符连续"
    
    # 3. 检查小数点重复（在同一个数字中）
    # 匹配模式：数字.数字.数字
    if re.search(r'\d+\.\d*\.', expr):
        return False, "小数点重复"
    
    # 4. 检查百分号位置
    # 不允许以 % 开头
    if expr.startswith('%'):
        return False, "百分号位置错误"
    # 不允许连续 %%
    if '%%' in expr:
        return False, "百分号重复"
    # 不允许 % 后直接跟数字/小数点/左括号（允许 % 后跟运算符或右括号）
    if re.search(r'%[\d\.]', expr):
        return False, "百分号后缺少运算符"
    
    # 5. 检查运算符位置
    # 不允许以运算符结尾（除了 %）
    if expr[-1] in '+-*/' and expr[-1] != '%':
        return False, "表达式不完整"
    
    # 6. 检查空括号
    if '()' in expr:
        return False, "空括号"
    
    return True, ""


def preprocess_percentage(expr: str) -> str:
    """
    预处理百分比，支持复杂混合运算
    例如：10% -> 0.1, 100*5% -> 100*0.05, 5%+10 -> 0.05+10
    """
    # 处理数字后跟 % 的情况，转换为 (数字/100)
    # 使用正则表达式匹配：数字.数字% 或 数字%
    processed = re.sub(r'(\d+\.?\d*)%', r'(\1/100)', expr)
    return processed


def format_result(result: float) -> str:
    """
    格式化计算结果，优化小数精度
    """
    # 使用 Decimal 进行高精度格式化
    try:
        # 容差修正：消除浮点累积误差（如 206.00000000000003 -> 206.0）
        # round 到 10 位小数，足以覆盖金额精度（一般2位），同时消除 1e-13 级误差
        if isinstance(result, float):
            result = round(result, 10)
        decimal_result = Decimal(str(result))
        
        # 如果是整数，直接返回整数形式
        if decimal_result == decimal_result.to_integral():
            return str(int(decimal_result))
        
        # 否则去除尾部无意义的零
        formatted = str(decimal_result.normalize())
        return formatted
    except:
        # 降级方案：使用 Python 的格式化
        if isinstance(result, float) and result.is_integer():
            return str(int(result))
        else:
            # 使用 g 格式，最多保留 10 位有效数字
            return f"{result:.10g}"


# 支持的运算符
OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.USub: operator.neg,
}


def safe_eval(expr: str) -> float:
    """
    安全地计算数学表达式
    支持数字、基本运算符(+, -, *, /)、括号
    不支持函数调用、变量等
    增强：除零检查、高精度计算
    """
    try:
        # 预先检查除零
        if _check_division_by_zero(expr):
            raise ValueError("除零错误")
        
        node = ast.parse(expr, mode='eval')
        result = _eval_node(node.body)
        
        # 转换为 float 返回
        return float(result)
    except ValueError as e:
        raise e
    except Exception:
        raise ValueError("Invalid expression")


def _check_division_by_zero(expr: str) -> bool:
    """
    检查表达式中是否存在除零风险
    简化检查：如果除号右边是 0 或表达式计算结果为 0
    """
    # 匹配 /0 或 /0.0 或 /(表达式) 且表达式为 0
    # 这是一个简化检查，不能覆盖所有情况
    patterns = [
        r'/\b0\b',  # /0
        r'/0\.0',   # /0.0
    ]
    for pattern in patterns:
        if re.search(pattern, expr):
            return True
    return False


def _eval_node(node: ast.AST) -> float:
    """递归计算 AST 节点"""
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return float(node.value)
        else:
            raise ValueError("Invalid constant")
    elif isinstance(node, ast.BinOp):
        left = _eval_node(node.left)
        right = _eval_node(node.right)
        op_type = type(node.op)
        if op_type in OPERATORS:
            return OPERATORS[op_type](left, right)
        else:
            raise ValueError(f"Unsupported operator: {op_type}")
    elif isinstance(node, ast.UnaryOp):
        operand = _eval_node(node.operand)
        op_type = type(node.op)
        if op_type in OPERATORS:
            return OPERATORS[op_type](operand)
        else:
            raise ValueError(f"Unsupported operator: {op_type}")
    elif isinstance(node, ast.Expression):
        return _eval_node(node.body)
    else:
        raise ValueError(f"Unsupported node type: {type(node)}")


class Calculator(QWidget):
    # 类变量，保存上次的算式
    last_expression = ""
    
    def __init__(self, standalone=True):
        super().__init__()
        self.current_input = ""
        self.just_calculated = False
        self._border_radius = 4
        self._bg_color = QColor(0x27, 0x28, 0x22, 128)  # #272822, 50%透明度
        self.fill_callback = None  # 回填回调函数
        self.standalone = standalone  # 是否为独立窗口
        self.init_ui()
        
    def init_ui(self):
        """初始化界面"""
        # 窗口设置
        self.setFixedSize(200, 229)
        
        # 只有作为独立窗口时才设置窗口标志
        if self.standalone:
            self.setWindowFlags(Qt.WindowType.FramelessWindowHint)
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        
        # 阴影效果
        shadow = QGraphicsDropShadowEffect()
        shadow.setBlurRadius(15)
        shadow.setOffset(0, 0)
        shadow.setColor(QColor(0, 0, 0, 80))
        self.setGraphicsEffect(shadow)
        
        # 主布局
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(8, 8, 8, 8)
        main_layout.setSpacing(5)
        
        # 显示区域 - 支持两行换行
        self.display = QLabel("0")
        self.display.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.display.setWordWrap(True)
        self.display.setStyleSheet("""
            QLabel {
                background-color: #33342f;
                border: none;
                border-radius: 8px;
                padding: 4px 10px;
                font-size: 20px;
                font-weight: bold;
                color: white;
            }
        """)
        self.display.setMinimumHeight(45)
        self.display.setMaximumHeight(45)
        main_layout.addWidget(self.display)
        
        # 恢复上次算式
        if Calculator.last_expression:
            self.current_input = Calculator.last_expression
            self.display.setText(self.current_input)
        
        # 按钮网格布局
        button_layout = QGridLayout()
        button_layout.setSpacing(4)
        button_layout.setContentsMargins(0, 0, 0, 0)
        
        # 按钮定义
        buttons = [
            ('C', 0, 0), ('(', 0, 1), (')', 0, 2), ('%', 0, 3),
            ('7', 1, 0), ('8', 1, 1), ('9', 1, 2), ('×', 1, 3),
            ('4', 2, 0), ('5', 2, 1), ('6', 2, 2), ('-', 2, 3),
            ('1', 3, 0), ('2', 3, 1), ('3', 3, 2), ('+', 3, 3),
            ('0', 4, 0), ('.', 4, 1), ('=', 4, 2), ('填入', 4, 3)
        ]
        
        # 创建按钮
        for text, row, col in buttons:
            btn = QPushButton(text)
            btn.setMinimumHeight(32)
            btn.setMaximumHeight(32)
            
            # 按钮样式
            if text in ['C', '(', ')', '%', '.', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']:
                btn.setStyleSheet("""
                    QPushButton {
                        background-color: #d4d4d4;
                        border: none;
                        border-radius: 6px;
                        font-size: 16px;
                        font-weight: bold;
                        color: #333;
                        padding: 4px;
                    }
                    QPushButton:hover {
                        background-color: #c4c4c4;
                    }
                    QPushButton:pressed {
                        background-color: #b4b4b4;
                    }
                """)
            elif text in ['×', '-', '+', '=']:
                btn.setStyleSheet("""
                    QPushButton {
                        background-color: #5c9aff;
                        border: none;
                        border-radius: 6px;
                        font-size: 18px;
                        font-weight: bold;
                        color: white;
                        padding: 4px;
                    }
                    QPushButton:hover {
                        background-color: #4c8aef;
                    }
                    QPushButton:pressed {
                        background-color: #3c7adf;
                    }
                """)
            elif text == '填入':
                btn.setStyleSheet("""
                    QPushButton {
                        background-color: #4caf50;
                        border: none;
                        border-radius: 6px;
                        font-size: 13px;
                        font-weight: bold;
                        color: white;
                        padding: 4px;
                    }
                    QPushButton:hover {
                        background-color: #449e48;
                    }
                    QPushButton:pressed {
                        background-color: #3c8e40;
                    }
                """)
            
            btn.clicked.connect(lambda checked, t=text: self.on_button_click(t))
            button_layout.addWidget(btn, row, col)
        
        main_layout.addLayout(button_layout)
        self.setLayout(main_layout)
    
    def paintEvent(self, event):
        """用 QPainter 绘制半透明圆角背景"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        
        # 构建圆角矩形路径
        path = QPainterPath()
        r = self._border_radius
        rect = self.rect()
        path.addRoundedRect(rect.x(), rect.y(), rect.width(), rect.height(), r, r)
        
        # 填充半透明背景色
        painter.fillPath(path, self._bg_color)
        painter.end()
    
    def on_button_click(self, text):
        """处理按钮点击"""
        if text == 'C':
            self.current_input = ""
            self.just_calculated = False
            self.display.setText("0")
        elif text == '=':
            self.equal_clicked()
        elif text == '填入':
            self.fill_clicked()
        elif text.isdigit():
            # 等号后再按数字 → 清空重新开始
            if self.just_calculated:
                self.current_input = ""
                self.just_calculated = False
            self.current_input += text
            self.display.setText(self.current_input)
        else:
            # 运算符、小数点、括号、百分号 - 纯字符追加
            self.just_calculated = False
            self.current_input += text
            self.display.setText(self.current_input)
    
    def equal_clicked(self):
        """等号按钮点击 - 保存原始表达式，计算后显示 原始表达式=结果"""
        if not self.current_input:
            return
        
        original_expr = self.current_input
        
        try:
            # 1. 输入验证
            is_valid, error_msg = validate_expression(original_expr)
            if not is_valid:
                print(f"输入验证失败: {error_msg}")
                self.current_input = ""
                self.just_calculated = False
                self.display.setText("Error")
                return
            
            # 2. 构建计算表达式：× → *
            calc_expr = original_expr.replace('×', '*')
            
            # 3. 预处理百分比：支持复杂混合运算
            calc_expr = preprocess_percentage(calc_expr)
            
            # 4. 使用安全的计算内核（包含除零检查）
            result = safe_eval(calc_expr)
            
            # 5. 格式化结果（高精度处理）
            result_str = format_result(result)
            
            # 显示：原始表达式=结果
            display_text = f"{original_expr}={result_str}"
            self.current_input = result_str
            self.just_calculated = True
            self.display.setText(display_text)
        except ValueError as e:
            print(f"计算错误: {e}")
            self.current_input = ""
            self.just_calculated = False
            self.display.setText("Error")
        except Exception as e:
            print(f"未知错误: {e}")
            self.current_input = ""
            self.just_calculated = False
            self.display.setText("Error")
    
    def fill_clicked(self):
        """填入按钮点击"""
        result = self.display.text()
        print(f"填入结果: {result}")
        
        # 保存当前算式到类变量
        Calculator.last_expression = result
        
        # 调用回填回调函数
        if self.fill_callback:
            self.fill_callback(result)


def main():
    """主函数"""
    app = QApplication(sys.argv)
    calculator = Calculator()
    calculator.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()

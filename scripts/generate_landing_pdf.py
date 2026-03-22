# -*- coding: utf-8 -*-
"""
DunCrew 产品页文案 + 截图 PDF 生成脚本
"""
import os
from fpdf import FPDF

SCREENSHOTS_DIR = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'DunCrew产品页素材.pdf')
FONT_PATH = 'C:/Windows/Fonts/msyh.ttc'
FONT_BOLD_PATH = 'C:/Windows/Fonts/msyhbd.ttc'


class DunCrewPDF(FPDF):
    def header(self):
        self.set_font('msyh', 'B', 10)
        self.set_text_color(160, 160, 160)
        self.cell(0, 8, 'DunCrew - duncrew.cn 产品页素材', align='R')
        self.ln(12)

    def footer(self):
        self.set_y(-15)
        self.set_font('msyh', '', 8)
        self.set_text_color(180, 180, 180)
        self.cell(0, 10, f'第 {self.page_no()} 页', align='C')


def build_pdf():
    pdf = DunCrewPDF(orientation='P', unit='mm', format='A4')
    pdf.set_auto_page_break(auto=True, margin=20)

    # 注册中文字体
    pdf.add_font('msyh', '', FONT_PATH, uni=True)
    pdf.add_font('msyh', 'B', FONT_BOLD_PATH, uni=True)

    # ========== 封面 ==========
    pdf.add_page()
    pdf.ln(60)
    pdf.set_font('msyh', 'B', 36)
    pdf.set_text_color(30, 30, 30)
    pdf.cell(0, 20, 'DunCrew', align='C', new_x='LMARGIN', new_y='NEXT')

    pdf.set_font('msyh', '', 18)
    pdf.set_text_color(80, 80, 80)
    pdf.cell(0, 14, '给你的 AI 一个工位', align='C', new_x='LMARGIN', new_y='NEXT')

    pdf.ln(10)
    pdf.set_font('msyh', '', 12)
    pdf.set_text_color(130, 130, 130)
    pdf.cell(0, 10, 'duncrew.cn 产品落地页素材包', align='C', new_x='LMARGIN', new_y='NEXT')
    pdf.cell(0, 8, '文案 + 产品截图', align='C', new_x='LMARGIN', new_y='NEXT')

    # ========== 一句话定位 ==========
    pdf.add_page()
    pdf.set_font('msyh', 'B', 22)
    pdf.set_text_color(30, 30, 30)
    pdf.cell(0, 16, '产品定位', new_x='LMARGIN', new_y='NEXT')

    pdf.ln(4)
    pdf.set_font('msyh', 'B', 16)
    pdf.set_text_color(60, 60, 60)
    pdf.cell(0, 12, '一句话: 给你的 AI 一个工位', new_x='LMARGIN', new_y='NEXT')

    pdf.ln(4)
    pdf.set_font('msyh', '', 11)
    pdf.set_text_color(80, 80, 80)
    desc = (
        'DunCrew 不是又一个聊天机器人。\n'
        '它是一套运行在你电脑上的 AI 操作系统 -- 你可以给 AI 分配"工位"，'
        '让它们各司其职，越用越专业。\n\n'
        '不上传数据，不依赖云端，所有能力都长在你自己的电脑里。'
    )
    pdf.multi_cell(0, 7, desc)

    # ========== 6 张功能卡 ==========
    cards = [
        {
            'num': '01',
            'title': 'Nexus 专家体系',
            'subtitle': '养虾，不如孵蛋',
            'body': (
                '大多数 AI 工具是"现成的虾" -- 买来就用，但永远不会变。\n'
                'DunCrew 里的每个 Nexus 是一颗"蛋"：\n'
                '  - 刚孵出来什么都不太会\n'
                '  - 用得越多，越懂你的需求\n'
                '  - 每个 Nexus 会发展出自己的专长\n'
                '  - 最终变成只属于你的专家团队\n\n'
                '你不是在"用工具"，你是在"养团队"。'
            ),
            'screenshot': '01-world-dashboard.png',
            'screenshot_caption': 'World 画布 -- 你的 AI 专家团队一览',
        },
        {
            'num': '02',
            'title': '自我反思',
            'subtitle': '摔过的坑，自己填上',
            'body': (
                '普通 AI 犯了错，下次还犯。\n'
                'DunCrew 的 Nexus 不一样：\n'
                '  - 每次任务结束，自动复盘\n'
                '  - 哪里做得好、哪里翻车，它自己写总结\n'
                '  - 下次遇到类似情况，会自动绕开老坑\n\n'
                '不需要你反复纠正，它自己就在进步。'
            ),
            'screenshot': '03-chat-interface.png',
            'screenshot_caption': 'AI 对话界面 -- 结构化回复 + 选项引导',
        },
        {
            'num': '03',
            'title': '真正的记忆',
            'subtitle': '它真的记得你',
            'body': (
                '大多数 AI 聊完就忘，DunCrew 有三层记忆：\n'
                '  - 短期记忆：这次对话里发生了什么\n'
                '  - 长期记忆：上个月帮你做过什么\n'
                '  - 共享记忆：一个 Nexus 学到的经验，其他 Nexus 也能用\n\n'
                '"上次那个报告的格式，再来一份" -- 它真的能做到。'
            ),
            'screenshot': None,
            'screenshot_caption': '',
        },
        {
            'num': '04',
            'title': '本地运行',
            'subtitle': '门都不出',
            'body': (
                '你的文件、对话、记忆 -- 全都在你自己电脑上。\n'
                '  - 不上传到任何云端服务器\n'
                '  - 不需要注册账号\n'
                '  - 断网了？本地模型照样跑\n\n'
                '隐私不是功能，是底线。'
            ),
            'screenshot': '04-soul-tower.png',
            'screenshot_caption': 'Soul 灵魂塔 -- MBTI 人格系统，独一无二的 AI 身份',
        },
        {
            'num': '05',
            'title': '兼容 OpenClaw',
            'subtitle': '熟悉的味道，不一样的灵魂',
            'body': (
                '如果你用过 OpenAI 的 GPTs，上手零门槛：\n'
                '  - 一键导入 OpenClaw 配置\n'
                '  - 但这里的 AI 会成长、会反思、有记忆\n'
                '  - 同样的配置，在 DunCrew 里活过来\n\n'
                '不是替代品，是进化版。'
            ),
            'screenshot': '02-nexus-detail.png',
            'screenshot_caption': 'Nexus 详情面板 -- 成长评分、成就系统、能力维度',
        },
        {
            'num': '06',
            'title': '三步开始',
            'subtitle': '下载，打开，开聊',
            'body': (
                '第一步：下载 DunCrew 安装包 (Windows)\n'
                '第二步：打开后，在设置里填入你的 API Key\n'
                '         (支持 OpenAI / Claude / 国产大模型)\n'
                '第三步：选一个 Nexus 开始对话，或者自己创建一个\n\n'
                '不需要懂代码，不需要配环境。\n'
                '下载、打开、开聊。就这么简单。'
            ),
            'screenshot': '01-world-dashboard.png',
            'screenshot_caption': 'World 全景 -- 创建你的第一个 Nexus 专家',
        },
    ]

    for card in cards:
        pdf.add_page()

        # 编号 + 标题
        pdf.set_font('msyh', 'B', 28)
        pdf.set_text_color(200, 200, 200)
        pdf.cell(20, 16, card['num'])
        pdf.set_text_color(30, 30, 30)
        pdf.set_font('msyh', 'B', 20)
        pdf.cell(0, 16, card['title'], new_x='LMARGIN', new_y='NEXT')

        # 副标题
        pdf.set_font('msyh', 'B', 14)
        pdf.set_text_color(100, 100, 100)
        pdf.cell(0, 10, card['subtitle'], new_x='LMARGIN', new_y='NEXT')

        pdf.ln(4)

        # 正文
        pdf.set_font('msyh', '', 11)
        pdf.set_text_color(60, 60, 60)
        pdf.multi_cell(0, 7, card['body'])

        # 截图
        if card['screenshot']:
            img_path = os.path.join(SCREENSHOTS_DIR, card['screenshot'])
            if os.path.exists(img_path):
                pdf.ln(6)
                # 居中放置截图，宽度占页面 90%
                page_w = pdf.w - pdf.l_margin - pdf.r_margin
                img_w = page_w * 0.95
                x_offset = pdf.l_margin + (page_w - img_w) / 2
                pdf.image(img_path, x=x_offset, w=img_w)
                # 图片说明
                pdf.ln(3)
                pdf.set_font('msyh', '', 9)
                pdf.set_text_color(150, 150, 150)
                pdf.cell(0, 6, card['screenshot_caption'], align='C', new_x='LMARGIN', new_y='NEXT')

    # ========== 商业描述页 ==========
    pdf.add_page()
    pdf.set_font('msyh', 'B', 22)
    pdf.set_text_color(30, 30, 30)
    pdf.cell(0, 16, '阿里云建站 -- 商业描述', new_x='LMARGIN', new_y='NEXT')

    pdf.ln(4)
    pdf.set_font('msyh', '', 11)
    pdf.set_text_color(60, 60, 60)
    biz_desc = (
        '品牌名称：DunCrew\n'
        '域名：duncrew.cn\n'
        '定位：给你的 AI 一个工位\n\n'
        '产品类型：本地运行的 AI 操作系统（桌面应用）\n'
        '目标用户：需要频繁使用 AI 完成工作的个人和小团队\n'
        '（内容创作者、运营、研究员、自由职业者等）\n\n'
        '核心差异化：\n'
        '1. AI 会成长 -- 越用越专业（Nexus 专家体系 + 等级系统）\n'
        '2. AI 会反思 -- 犯了错自己复盘（Reflexion 机制）\n'
        '3. AI 有记忆 -- 记得你的偏好和历史（三层记忆架构）\n'
        '4. 完全本地 -- 数据不出你的电脑（隐私优先）\n'
        '5. 有个性 -- MBTI 人格系统，不是冷冰冰的工具\n\n'
        '分发方式：Windows 桌面安装包（一键安装）\n'
        '商业模式：开源免费，用户自带 API Key'
    )
    pdf.multi_cell(0, 7, biz_desc)

    # 输出
    pdf.output(OUTPUT_PATH)
    print(f'PDF 已生成: {OUTPUT_PATH}')
    print(f'文件大小: {os.path.getsize(OUTPUT_PATH) / 1024:.0f} KB')


if __name__ == '__main__':
    build_pdf()

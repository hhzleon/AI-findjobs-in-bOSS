#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BOSS直聘职位详情爬取工具
用户登录后加载URL并提取工作职位信息
"""

import DrissionPage
import csv
import time
import os
from urllib.parse import urlparse

class JobDetailCrawler:
    def __init__(self):
        """初始化爬虫"""
        self.tab = DrissionPage.Chromium().latest_tab
        self.job_urls = []
        self.job_details = []
        self.output_filename = 'job_details_with_text.csv'
        
    def load_job_urls(self, csv_file='boss_job_url.csv'):
        """
        从CSV文件加载职位URL
        
        Args:
            csv_file (str): CSV文件名
            
        Returns:
            bool: 是否加载成功
        """
        try:
            with open(csv_file, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                
                for row in reader:
                    # 只处理职位详情类型的URL
                    if row['类型'] == '职位详情' and row['URL'] != 'N/A':
                        job_info = {
                            '索引': row['索引'],
                            '职位名称': row['职位名称'],
                            '公司名称': row['公司名称'],
                            '薪资': row['薪资'],
                            '工作经验': row['工作经验'],
                            '学历要求': row['学历要求'],
                            'URL': row['URL']
                        }
                        self.job_urls.append(job_info)
                
                print(f"成功加载 {len(self.job_urls)} 个职位详情URL")
                return True
                
        except FileNotFoundError:
            print(f"错误: 找不到文件 {csv_file}")
            return False
        except Exception as e:
            print(f"加载URL文件时出错: {e}")
            return False
    
    def login_check(self):
        """
        检查用户是否已登录（类似main.py的方式）
        
        Returns:
            bool: 是否已登录
        """
        try:
            # 打开BOSS直聘
            print("正在打开BOSS直聘...")
            self.tab.get("https://www.zhipin.com/")
            time.sleep(3)
            
            # 等待用户手动登录确认
            islogin = input("请输入是否登录(y/n): ")
            
            if islogin.lower() == "y":
                print("用户确认已登录，继续执行...")
                return True
            else:
                print("请先登录BOSS直聘")
                return False
                
        except Exception as e:
            print(f"检查登录状态时出错: {e}")
            return False
    
    def save_job_detail_to_csv(self, job_info):
        """
        将单个职位信息保存到CSV文件（追加模式）
        
        Args:
            job_info (dict): 职位信息
        """
        try:
            # 检查文件是否存在，如果不存在则创建并写入表头
            file_exists = os.path.exists(self.output_filename)
            
            with open(self.output_filename, 'a', newline='', encoding='utf-8-sig') as csvfile:
                fieldnames = [
                    '索引', '职位名称', '公司名称', '薪资', '工作经验', 
                    '学历要求', '工作文字信息', 'URL'
                ]
                
                writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                
                # 如果文件不存在，写入表头
                if not file_exists:
                    writer.writeheader()
                
                # 写入职位信息
                writer.writerow(job_info)
            
            print(f"✓ 已保存到文件: {job_info['职位名称']}")
            
        except Exception as e:
            print(f"保存文件时出错: {e}")
    
    def extract_job_text_info(self, url):
        """
        从职位详情页提取工作文字信息
        
        Args:
            url (str): 职位详情页URL
            
        Returns:
            str: 提取的文字信息
        """
        try:
            # 访问职位详情页
            self.tab.get(url)
            time.sleep(3)
            
            # 等待页面加载
            self.tab.wait(2)
            
            # 提取指定的文字信息
            # 使用CSS选择器: #main > div.job-box > div > div.job-detail > div:nth-child(1) > div.job-sec-text
            css_selector = "#main > div.job-box > div > div.job-detail > div:nth-child(1) > div.job-sec-text"
            
            # 尝试多种选择器来定位元素
            selectors = [
                css_selector,
                "div.job-sec-text",
                "div.job-detail div.job-sec-text",
                "//div[contains(@class, 'job-sec-text')]",
                "//div[contains(@class, 'job-detail')]//div[contains(@class, 'job-sec-text')]"
            ]
            
            job_text = ""
            
            for selector in selectors:
                try:
                    if selector.startswith("//"):
                        # XPath选择器
                        elements = self.tab.eles(f'xpath:{selector}')
                    else:
                        # CSS选择器
                        elements = self.tab.eles(f'css:{selector}')
                    
                    if elements:
                        # 获取所有匹配元素的文本
                        texts = [elem.text for elem in elements if elem.text]
                        if texts:
                            job_text = " ".join(texts).strip()
                            print(f"成功提取工作文字信息，长度: {len(job_text)}")
                            break
                            
                except Exception as e:
                    print(f"使用选择器 {selector} 提取失败: {e}")
                    continue
            
            if not job_text:
                print("未能提取到工作文字信息，尝试获取页面主要内容...")
                # 备用方案：获取页面主要内容
                try:
                    main_content = self.tab.ele('css:#main')
                    if main_content:
                        job_text = main_content.text[:1000] + "..." if len(main_content.text) > 1000 else main_content.text
                        print(f"获取到页面主要内容，长度: {len(job_text)}")
                except:
                    job_text = "无法提取工作信息"
            
            return job_text
            
        except Exception as e:
            print(f"提取工作文字信息时出错: {e}")
            return f"提取失败: {str(e)}"
    
    def crawl_job_details(self, start_index=0, end_index=None, delay=2):
        """
        爬取职位详情信息（实时保存）
        
        Args:
            start_index (int): 开始索引
            end_index (int): 结束索引，None表示爬取所有
            delay (int): 请求间隔时间（秒）
            
        Returns:
            int: 成功爬取的职位数量
        """
        if not self.job_urls:
            print("没有可用的职位URL")
            return 0
        
        if end_index is None:
            end_index = len(self.job_urls)
        
        successful_count = 0
        failed_count = 0
        
        print(f"开始爬取职位详情，范围: {start_index} - {end_index}")
        print("注意：每个职位爬取完成后会立即保存到文件，您可以实时查看更新")
        
        # 删除已存在的文件，重新开始
        if os.path.exists(self.output_filename):
            os.remove(self.output_filename)
            print(f"已删除旧文件: {self.output_filename}")
        
        for i in range(start_index, end_index):
            if i >= len(self.job_urls):
                break
                
            job_info = self.job_urls[i]
            print(f"\n[{i+1}/{end_index}] 正在爬取: {job_info['职位名称']} - {job_info['公司名称']}")
            
            try:
                # 提取工作文字信息
                job_text = self.extract_job_text_info(job_info['URL'])
                
                # 构建完整的职位信息
                complete_job_info = {
                    '索引': job_info['索引'],
                    '职位名称': job_info['职位名称'],
                    '公司名称': job_info['公司名称'],
                    '薪资': job_info['薪资'],
                    '工作经验': job_info['工作经验'],
                    '学历要求': job_info['学历要求'],
                    '工作文字信息': job_text,
                    'URL': job_info['URL']
                }
                
                # 立即保存到文件
                self.save_job_detail_to_csv(complete_job_info)
                self.job_details.append(complete_job_info)
                successful_count += 1
                
                print(f"✓ 成功爬取并保存: {job_info['职位名称']}")
                
                # 添加延迟，避免请求过于频繁
                if delay > 0:
                    time.sleep(delay)
                    
            except Exception as e:
                print(f"✗ 爬取失败: {job_info['职位名称']} - 错误: {e}")
                
                # 即使失败也添加记录，但工作文字信息为空
                failed_job_info = {
                    '索引': job_info['索引'],
                    '职位名称': job_info['职位名称'],
                    '公司名称': job_info['公司名称'],
                    '薪资': job_info['薪资'],
                    '工作经验': job_info['工作经验'],
                    '学历要求': job_info['学历要求'],
                    '工作文字信息': f"爬取失败: {str(e)}",
                    'URL': job_info['URL']
                }
                
                # 保存失败记录
                self.save_job_detail_to_csv(failed_job_info)
                self.job_details.append(failed_job_info)
                failed_count += 1
        
        print(f"\n爬取完成！成功爬取 {successful_count} 个职位详情，失败 {failed_count} 个")
        return successful_count
    
    def show_file_info(self):
        """显示输出文件信息"""
        if os.path.exists(self.output_filename):
            file_size = os.path.getsize(self.output_filename)
            print(f"文件大小: {file_size / 1024:.2f} KB")
            
            # 统计行数
            try:
                with open(self.output_filename, 'r', encoding='utf-8-sig') as f:
                    line_count = sum(1 for line in f)
                print(f"文件行数: {line_count} 行（包含表头）")
            except:
                pass
    
    def run(self, start_index=0, end_index=None, delay=2):
        """
        运行爬虫主流程
        
        Args:
            start_index (int): 开始索引
            end_index (int): 结束索引
            delay (int): 请求间隔时间
        """
        print("BOSS直聘职位详情爬取工具 - 实时保存版")
        print("="*50)
        
        # 1. 检查登录状态（类似main.py的方式）
        if not self.login_check():
            print("请先登录BOSS直聘，然后重新运行程序")
            return
        
        # 2. 加载职位URL
        if not self.load_job_urls():
            print("加载职位URL失败，程序退出")
            return
        
        # 3. 爬取职位详情（实时保存）
        successful_count = self.crawl_job_details(start_index, end_index, delay)
        
        # 4. 显示完成总结
        print(f"\n" + "="*50)
        print("爬取完成！")
        print(f"成功爬取: {successful_count} 个职位")
        print(f"总计处理: {len(self.job_details)} 个职位")
        print(f"结果已保存到: {self.output_filename}")
        print("="*50)
        
        # 显示文件信息
        self.show_file_info()

def main():
    """主函数（类似main.py的结构）"""
    print("BOSS直聘职位详情爬取工具")
    print("="*60)
    
    # 创建爬虫实例
    crawler = JobDetailCrawler()
    
    # 获取用户输入
    print("请输入爬取参数:")
    
    try:
        start_index = int(input("开始索引 (默认0): ") or "0")
        end_input = input("结束索引 (默认爬取所有，输入数字限制范围): ")
        end_index = int(end_input) if end_input.strip() else None
        delay = int(input("请求间隔秒数 (默认2): ") or "2")
        
        # 运行爬虫
        crawler.run(start_index, end_index, delay)
        
    except ValueError:
        print("输入格式错误，使用默认参数")
        crawler.run()
    except KeyboardInterrupt:
        print("\n用户中断程序")
    except Exception as e:
        print(f"程序运行出错: {e}")

if __name__ == "__main__":
    main()

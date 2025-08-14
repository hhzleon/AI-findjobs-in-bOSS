#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
简化版BOSS直聘职位详情爬取工具 - 支持实时保存
"""

import DrissionPage
import csv
import time
import os

def save_job_detail_to_csv(job_info, filename='job_details_with_text.csv'):
    """
    将单个职位信息保存到CSV文件（追加模式）
    
    Args:
        job_info (dict): 职位信息
        filename (str): 文件名
    """
    try:
        # 检查文件是否存在，如果不存在则创建并写入表头
        file_exists = os.path.exists(filename)
        
        with open(filename, 'a', newline='', encoding='utf-8-sig') as csvfile:
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

def main():
    """主函数"""
    print("BOSS直聘职位详情爬取工具 - 简化版（实时保存）")
    print("="*60)
    
    # 创建浏览器实例
    tab = DrissionPage.Chromium().latest_tab
    
    # 1. 检查登录状态（类似main.py的方式）
    print("正在打开BOSS直聘...")
    tab.get("https://www.zhipin.com/")
    time.sleep(3)
    
    # 等待用户手动登录确认
    islogin = input("请输入是否登录(y/n): ")
    if islogin.lower() != "y":
        print("请先登录BOSS直聘")
        return
    
    print("用户确认已登录，继续执行...")
    
    # 2. 加载职位URL
    print("正在加载职位URL...")
    job_urls = []
    
    try:
        with open('boss_job_url.csv', 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            
            for row in reader:
                if row['类型'] == '职位详情' and row['URL'] != 'N/A':
                    job_urls.append({
                        '索引': row['索引'],
                        '职位名称': row['职位名称'],
                        '公司名称': row['公司名称'],
                        '薪资': row['薪资'],
                        '工作经验': row['工作经验'],
                        '学历要求': row['学历要求'],
                        'URL': row['URL']
                    })
        
        print(f"成功加载 {len(job_urls)} 个职位详情URL")
        
    except FileNotFoundError:
        print("错误: 找不到 boss_job_url.csv 文件")
        return
    except Exception as e:
        print(f"加载URL文件时出错: {e}")
        return
    
    # 3. 获取爬取参数
    print(f"\n共有 {len(job_urls)} 个职位需要爬取")
    
    try:
        start_input = input("开始索引 (默认0): ").strip()
        start_index = int(start_input) if start_input else 0
        
        end_input = input("结束索引 (默认爬取所有): ").strip()
        end_index = int(end_input) if end_input else len(job_urls)
        
        delay_input = input("请求间隔秒数 (默认3): ").strip()
        delay = int(delay_input) if delay_input else 3
        
    except ValueError:
        print("输入格式错误，使用默认参数")
        start_index = 0
        end_index = len(job_urls)
        delay = 3
    
    # 4. 开始爬取（实时保存）
    print(f"\n开始爬取职位详情，范围: {start_index} - {end_index}")
    print(f"请求间隔: {delay} 秒")
    print("注意：每个职位爬取完成后会立即保存到文件，您可以实时查看更新")
    
    successful_count = 0
    failed_count = 0
    
    # 删除已存在的文件，重新开始
    output_filename = 'job_details_with_text.csv'
    if os.path.exists(output_filename):
        os.remove(output_filename)
        print(f"已删除旧文件: {output_filename}")
    
    for i in range(start_index, end_index):
        if i >= len(job_urls):
            break
            
        job_info = job_urls[i]
        print(f"\n[{i+1}/{end_index}] 正在爬取: {job_info['职位名称']} - {job_info['公司名称']}")
        
        try:
            # 访问职位详情页
            tab.get(job_info['URL'])
            time.sleep(3)
            
            # 等待页面加载
            tab.wait(2)
            
            # 尝试多种选择器提取工作文字信息
            job_text = ""
            selectors = [
                "#main > div.job-box > div > div.job-detail > div:nth-child(1) > div.job-sec-text",
                "div.job-sec-text",
                "div.job-detail div.job-sec-text",
                "//div[contains(@class, 'job-sec-text')]",
                "//div[contains(@class, 'job-detail')]//div[contains(@class, 'job-sec-text')]"
            ]
            
            for selector in selectors:
                try:
                    if selector.startswith("//"):
                        elements = tab.eles(f'xpath:{selector}')
                    else:
                        elements = tab.eles(f'css:{selector}')
                    
                    if elements:
                        texts = [elem.text for elem in elements if elem.text]
                        if texts:
                            job_text = " ".join(texts).strip()
                            print(f"✓ 成功提取工作文字信息，长度: {len(job_text)}")
                            break
                            
                except Exception as e:
                    continue
            
            # 如果还是没提取到，尝试获取页面主要内容
            if not job_text:
                try:
                    main_content = tab.ele('css:#main')
                    if main_content:
                        job_text = main_content.text[:1000] + "..." if len(main_content.text) > 1000 else main_content.text
                        print(f"✓ 获取到页面主要内容，长度: {len(job_text)}")
                except:
                    job_text = "无法提取工作信息"
            
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
            save_job_detail_to_csv(complete_job_info, output_filename)
            successful_count += 1
            
            print(f"✓ 成功爬取并保存: {job_info['职位名称']}")
            
            # 添加延迟
            if delay > 0:
                time.sleep(delay)
                
        except Exception as e:
            print(f"✗ 爬取失败: {job_info['职位名称']} - 错误: {e}")
            
            # 即使失败也保存记录
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
            save_job_detail_to_csv(failed_job_info, output_filename)
            failed_count += 1
    
    # 5. 爬取完成总结
    print(f"\n" + "="*60)
    print("爬取完成！")
    print(f"成功爬取: {successful_count} 个职位")
    print(f"爬取失败: {failed_count} 个职位")
    print(f"总计处理: {successful_count + failed_count} 个职位")
    print(f"结果已保存到: {output_filename}")
    print("="*60)
    
    # 显示文件信息
    if os.path.exists(output_filename):
        file_size = os.path.getsize(output_filename)
        print(f"文件大小: {file_size / 1024:.2f} KB")
        
        # 统计行数
        try:
            with open(output_filename, 'r', encoding='utf-8-sig') as f:
                line_count = sum(1 for line in f)
            print(f"文件行数: {line_count} 行（包含表头）")
        except:
            pass

if __name__ == "__main__":
    main()

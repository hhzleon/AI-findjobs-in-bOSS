#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BOSS直聘URL构建工具
读取本地文件并拼写URL，在命令行一行一行输出，同时保存到CSV文件
"""

import os
import re
import time
import csv
from urllib.parse import quote

def read_api_templates():
    """
    读取api.md文件中的URL模板
    """
    templates = []
    
    try:
        with open('api.md', 'r', encoding='utf-8') as f:
            content = f.read()
            
        # 提取所有URL
        url_pattern = r'https://[^\s\n]+'
        urls = re.findall(url_pattern, content)
        
        for url in urls:
            if url.strip():
                templates.append(url.strip())
                
        print(f"成功读取 {len(templates)} 个URL模板")
        return templates
        
    except FileNotFoundError:
        print("错误: 找不到 api.md 文件")
        return []
    except Exception as e:
        print(f"读取文件时出错: {e}")
        return []

def read_job_data():
    """
    读取boss_jobs.csv文件中的职位数据
    """
    jobs = []
    
    try:
        import pandas as pd
        df = pd.read_csv('boss_jobs.csv', encoding='utf-8-sig')
        
        # 提取需要的字段
        for index, row in df.iterrows():
            job = {
                '索引': index,  # 添加索引字段
                '职位ID': row.get('职位ID', ''),
                '安全ID': row.get('安全ID', ''),
                '列表ID': row.get('列表ID', ''),
                '职位名称': row.get('职位名称', ''),
                '公司名称': row.get('公司名称', ''),
                '城市': row.get('城市', ''),
                '薪资': row.get('薪资', ''),
                '工作经验': row.get('工作经验', ''),
                '学历要求': row.get('学历要求', '')
            }
            jobs.append(job)
            
        print(f"成功读取 {len(jobs)} 个职位数据")
        return jobs
        
    except ImportError:
        print("错误: 需要安装pandas库，请运行: pip install pandas")
        return []
    except FileNotFoundError:
        print("错误: 找不到 boss_jobs.csv 文件")
        return []
    except Exception as e:
        print(f"读取职位数据时出错: {e}")
        return []

def build_job_urls(templates, jobs):
    """
    根据模板和职位数据构建URL
    """
    urls = []
    
    print(f"\n开始构建URL，共有 {len(templates)} 个模板和 {len(jobs)} 个职位...")
    
    for i, template in enumerate(templates, 1):
        print(f"\n处理模板 {i}: {template[:50]}...")
        
        if 'job_detail' in template and '{职位ID}' in template:
            # 职位详情页模板
            print(f"  识别为职位详情页模板")
            for job in jobs:
                if job['职位ID'] and job['安全ID']:
                    url = template.replace('{职位ID}', job['职位ID'])
                    url = url.replace('{安全ID}', job['安全ID'])
                    if '{列表ID}' in url:
                        url = url.replace('{列表ID}', job.get('列表ID', ''))
                    
                    urls.append({
                        '索引': job['索引'],
                        'type': '职位详情',
                        'url': url,
                        'job_name': job['职位名称'],
                        'company': job['公司名称'],
                        'city': job['城市'],
                        'salary': job['薪资'],
                        'experience': job['工作经验'],
                        'education': job['学历要求']
                    })
                    print(f"    生成职位详情URL: {job['职位名称']} - {job['公司名称']}")
        
        elif 'joblist.json' in template:
            # 工作列表API
            print(f"  识别为工作列表API")
            urls.append({
                '索引': 'N/A',
                'type': '工作列表API',
                'url': template,
                'job_name': '全栈开发',
                'company': 'N/A',
                'city': 'N/A',
                'salary': 'N/A',
                'experience': 'N/A',
                'education': 'N/A'
            })
        
        elif 'job/detail.json' in template:
            # 工作信息API
            print(f"  识别为工作信息API")
            urls.append({
                '索引': 'N/A',
                'type': '工作信息API',
                'url': template,
                'job_name': 'N/A',
                'company': 'N/A',
                'city': 'N/A',
                'salary': 'N/A',
                'experience': 'N/A',
                'education': 'N/A'
            })
        
        else:
            # 其他URL
            print(f"  识别为其他类型URL")
            urls.append({
                '索引': 'N/A',
                'type': '其他',
                'url': template,
                'job_name': 'N/A',
                'company': 'N/A',
                'city': 'N/A',
                'salary': 'N/A',
                'experience': 'N/A',
                'education': 'N/A'
            })
    
    print(f"\nURL构建完成，共生成 {len(urls)} 个URL")
    return urls

def save_urls_to_csv(urls, filename='boss_job_url.csv'):
    """
    将URL保存到CSV文件
    """
    try:
        with open(filename, 'w', newline='', encoding='utf-8-sig') as csvfile:
            # 定义CSV列名
            fieldnames = [
                '索引', '类型', '职位名称', '公司名称', '城市', '薪资', 
                '工作经验', '学历要求', 'URL'
            ]
            
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()
            
            # 写入数据
            for url_info in urls:
                writer.writerow({
                    '索引': url_info['索引'],
                    '类型': url_info['type'],
                    '职位名称': url_info['job_name'],
                    '公司名称': url_info['company'],
                    '城市': url_info['city'],
                    '薪资': url_info['salary'],
                    '工作经验': url_info['experience'],
                    '学历要求': url_info['education'],
                    'URL': url_info['url']
                })
        
        print(f"\n成功保存 {len(urls)} 个URL到文件: {filename}")
        return True
        
    except Exception as e:
        print(f"保存CSV文件时出错: {e}")
        return False

def output_urls(urls):
    """
    在命令行一行一行输出URL
    """
    print("\n" + "="*100)
    print("生成的URL列表:")
    print("="*100)
    
    for i, url_info in enumerate(urls, 1):
        print(f"\n{i}. {url_info['type']}")
        if url_info['索引'] != 'N/A':
            print(f"   索引: {url_info['索引']}")
        print(f"   职位: {url_info['job_name']}")
        print(f"   公司: {url_info['company']}")
        if url_info['city'] != 'N/A':
            print(f"   城市: {url_info['city']}")
        print(f"   URL: {url_info['url']}")
        print("-" * 100)
        
        # 添加延迟，让用户能看到每一行
        time.sleep(0.3)

def main():
    """
    主函数
    """
    print("BOSS直聘URL构建工具 - 增强版")
    print("="*60)
    print("新增功能: 保存URL到CSV文件，建立索引关系")
    print("="*60)
    
    # 读取API模板
    templates = read_api_templates()
    if not templates:
        print("没有找到URL模板，程序退出")
        return
    
    # 读取职位数据
    jobs = read_job_data()
    if not jobs:
        print("没有找到职位数据，将使用默认模板生成URL...")
        jobs = []
    
    # 构建URL
    urls = build_job_urls(templates, jobs)
    
    if not urls:
        print("没有生成任何URL")
        return
    
    # 保存URL到CSV文件
    if save_urls_to_csv(urls):
        print("CSV文件保存成功！")
    
    # 输出URL到命令行
    output_urls(urls)
    
    print(f"\n总共生成了 {len(urls)} 个URL")
    print("分析完成！")
    print(f"\n文件已保存为: boss_job_url.csv")
    print("该文件包含与 boss_jobs.csv 的索引关系，可以通过索引字段进行关联查询")

if __name__ == "__main__":
    main()
